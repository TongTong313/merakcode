/**
 * workflow_run is fire-and-forget: tool-result marks the part completed and removes it from toolcalls, and without
 * stop:true it was never kept in completedToolcalls. When the background run later pushed a terminal state,
 * updateToolCallMetadata couldn't find the part and it stayed stuck at the running snapshot from launch.
 *
 * LLM.stream feeds the workflow_run tool-call and tool-result, then the processor's public updateToolCallMetadata
 * simulates the background terminal push.
 */
import { afterEach, beforeEach, test, expect } from "vitest"
import type { Provider } from "@merakcode/engine/agent/model/provider"
import { Agent } from "@merakcode/engine/agent/agent"
import { Session } from "@merakcode/engine/agent/session/index"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Identifier } from "@merakcode/util/id"
import { Message } from "@merakcode/engine/agent/session/message"
import { Log } from "@merakcode/log/logger"
import { LLM } from "@merakcode/engine/agent/model/llm"

Log.init({ print: false })

const CID = "tc-wf-1"
const stream = LLM.stream

beforeEach(() => {
  LLM.stream = async () =>
    ({
      stream: (async function* () {
        yield { type: "start-step" }
        yield { type: "tool-input-start", id: CID, toolName: "workflow_run" }
        yield { type: "tool-call", toolCallId: CID, toolName: "workflow_run", input: { script: "x" } }
        // Launch snapshot returned right away by execute: metadata.status = "running"
        yield {
          type: "tool-result",
          toolCallId: CID,
          input: { script: "x" },
          output: {
            output: "Workflow launched in background.",
            metadata: { status: "running", workflowName: "demo", runId: "r1" },
            title: "demo",
          },
        }
      })(),
    }) as unknown as Awaited<ReturnType<typeof LLM.stream>>
})

afterEach(() => {
  LLM.stream = stream
})

test("background run can move a completed workflow_run tool part to its terminal state", async () => {
  const { SessionProcessor } = await import("@merakcode/engine/agent/loop/processor")
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const sessionID = session.id

      const user = await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID,
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-4" },
        time: { created: Date.now() },
      })

      const assistantInfo: Message.AssistantInfo = {
        id: Identifier.ascending("message"),
        role: "assistant",
        sessionID,
        mode: "build",
        agent: "build",
        path: { cwd: tmp.path, root: tmp.path },
        cost: 0,
        tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "gpt-4",
        providerID: "openai",
        parentID: user.id,
        time: { created: Date.now() },
      }
      await Session.updateInfo(assistantInfo)

      const model = {
        id: "gpt-4",
        providerID: "openai",
        modelID: "gpt-4",
        api: { id: "gpt-4" },
      } as unknown as Provider.Model

      const proc = SessionProcessor.create({
        assistantInfo,
        sessionID,
        model,
        abort: new AbortController().signal,
      })

      const agent = await Agent.get("build")
      await proc.process({
        user: user as Message.UserInfo,
        agent: agent!,
        abort: new AbortController().signal,
        sessionID,
        system: [],
        messages: [],
        tools: {},
        model,
      })

      // After tool-result the part is completed while its metadata is still the running launch snapshot.
      const afterProcess = (
        await Message.parts({ sessionID: assistantInfo.sessionID, messageID: assistantInfo.id })
      ).find((p): p is Message.ToolPart => p.type === "tool" && p.tool === "workflow_run")
      expect(afterProcess?.state.status).toBe("completed")

      // The background workflow reaches failed and pushes it via ctx.metadata -> updateToolCallMetadata.
      const ok = await proc.updateToolCallMetadata(CID, {
        title: "demo",
        metadata: {
          status: "failed",
          error: "ReferenceError: require is not defined",
          workflowName: "demo",
          runId: "r1",
        },
      })
      expect(ok).toBe(true)

      const wf = (await Message.parts({ sessionID: assistantInfo.sessionID, messageID: assistantInfo.id })).find(
        (p): p is Message.ToolPart => p.type === "tool" && p.tool === "workflow_run",
      )
      expect(wf?.state.status).toBe("completed")
      expect((wf?.state as { metadata?: { status?: string } }).metadata?.status).toBe("failed")
    },
  })
})
