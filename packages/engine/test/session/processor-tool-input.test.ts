/**
 * Streaming tool-input deltas: while pending, raw input accumulates and is partially parsed so the UI can show
 * filePath early.
 */
import { afterEach, test, expect } from "vitest"
import type { Provider } from "@merakcode/engine/provider/provider"
import { Agent } from "@merakcode/engine/agent/agent"
import { Session } from "@merakcode/engine/session/index"
import { Instance } from "@merakcode/engine/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Identifier } from "@merakcode/util/id"
import { Message } from "@merakcode/engine/session/message"
import { parseToolInputPartial } from "@merakcode/engine/session/processor"
import { Log } from "@merakcode/log/logger"
import { LLM } from "@merakcode/engine/session/llm"

Log.init({ print: false })

test("parseToolInputPartial extracts filePath while content is still unterminated", () => {
  const parsed = parseToolInputPartial('{"filePath":"/plans/fix-login.md","content":"')
  expect(parsed).toEqual({ filePath: "/plans/fix-login.md", content: "" })
})

const writeInput = { filePath: "/stream-test.txt", content: "hello" }
const stream = LLM.stream

afterEach(() => {
  LLM.stream = stream
})

test("pending write part has filePath after streamed input reaches tool-input-end", async () => {
  // Only LLM.stream is replaced: mock.module would drop LLM.prepareSystem and leak into later files.
  LLM.stream = async () =>
    ({
      stream: (async function* () {
        const cid = "tc-write-stream"
        yield { type: "start-step" }
        yield { type: "tool-input-start", id: cid, toolName: "write" }
        yield { type: "tool-input-delta", id: cid, delta: '{"filePath":"/stream-test.txt"' }
        yield { type: "tool-input-delta", id: cid, delta: ',"content":"hello"' }
        yield { type: "tool-input-end", id: cid }
        yield { type: "tool-call", toolCallId: cid, toolName: "write", input: writeInput }
        yield {
          type: "tool-result",
          toolCallId: cid,
          input: writeInput,
          output: { output: "ok", metadata: {}, title: "Write stream-test.txt", stop: true },
        }
      })(),
    }) as unknown as Awaited<ReturnType<typeof LLM.stream>>

  const { SessionProcessor } = await import("@merakcode/engine/session/processor")
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
      expect(agent).toBeDefined()

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

      const parts = await Message.parts({ sessionID: assistantInfo.sessionID, messageID: assistantInfo.id })
      const writePart = parts.find((p): p is Message.ToolPart => p.type === "tool" && p.tool === "write")
      expect(writePart).toBeDefined()
      expect(writePart!.state.status).toBe("completed")
      if (writePart!.state.status === "completed") {
        expect(writePart!.state.input.filePath).toBe("/stream-test.txt")
        expect(writePart!.state.input.content).toBe("hello")
      }

      expect(
        await proc.updateToolCallMetadata("tc-write-stream", {
          title: "Write stream-test.txt updated",
          metadata: { status: "running" },
        }),
      ).toBe(true)
      const updatedParts = await Message.parts({ sessionID: assistantInfo.sessionID, messageID: assistantInfo.id })
      const updated = updatedParts.find((p): p is Message.ToolPart => p.type === "tool" && p.tool === "write")
      expect(updated?.state.status).toBe("completed")
      if (updated?.state.status === "completed") {
        expect(updated.state.title).toBe("Write stream-test.txt updated")
        expect(updated.state.metadata.status).toBe("running")
      }
    },
  })
})
