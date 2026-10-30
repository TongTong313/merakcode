/**
 * doom_loop: after 3 consecutive calls of the same tool with the same input, a system-reminder is appended to the
 * tool-result output instead of asking the user. LLM.stream feeds a minimal event sequence; Session/Message storage
 * is real.
 */
import { afterEach, test, expect } from "vitest"
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

const readInput = { filePath: "/fixture-doom-loop.txt" }
const stream = LLM.stream

afterEach(() => {
  LLM.stream = stream
})

test("third identical read call output includes the doom_loop reminder", async () => {
  // Like the real SessionProcessor event sequence, each tool call is preceded by start-step, so parts contain
  // non-tool entries and detection must filter for tool parts to trigger.
  // Only LLM.stream is replaced: mock.module would drop LLM.prepareSystem and leak into later files.
  LLM.stream = async () =>
    ({
      stream: (async function* () {
        for (let i = 1; i <= 3; i++) {
          const cid = `tc-doom-${i}`
          yield { type: "start-step" }
          yield { type: "tool-input-start", id: cid, toolName: "read" }
          yield { type: "tool-call", toolCallId: cid, toolName: "read", input: readInput }
          yield {
            type: "tool-result",
            toolCallId: cid,
            input: readInput,
            output: { output: `round-${i}`, metadata: {}, title: "" },
          }
        }
      })(),
    }) as unknown as Awaited<ReturnType<typeof LLM.stream>>

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

      // tsc rejects casting a minimal stub straight to Provider.Model; going through unknown marks it as a stub.
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
      const completedReads = parts.filter(
        (p): p is Message.ToolPart => p.type === "tool" && p.tool === "read" && p.state.status === "completed",
      )
      expect(completedReads.length).toBe(3)
      const third = completedReads[completedReads.length - 1]!
      expect(third.state.status).toBe("completed")
      if (third.state.status === "completed") {
        expect(third.state.output).toContain("round-3")
        expect(third.state.output).toContain("<system-reminder>")
        expect(third.state.output).toContain("called the same tool with identical arguments 3 times in a row")
      }
    },
  })
})
