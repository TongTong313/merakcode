import { afterEach, describe, expect, test } from "vitest"
import { Bus } from "@merakcode/engine/bus/index"
import { Instance } from "@merakcode/engine/project/instance"
import { Provider } from "@merakcode/engine/provider/provider"
import { Session } from "@merakcode/engine/session/index"
import { LLM } from "@merakcode/engine/session/llm"
import { Message } from "@merakcode/engine/session/message"
import { SessionRunner } from "@merakcode/engine/session/runner"
import { SessionStatus } from "@merakcode/engine/session/status"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const realGetModel = Provider.getModel
const realStream = LLM.stream
afterEach(() => {
  Provider.getModel = realGetModel
  LLM.stream = realStream
})

const mockModel = {
  id: "test-model",
  providerID: "test",
  modelID: "test-model",
  name: "Test Model",
  limit: { context: 128_000, input: 0, output: 8_192 },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  capabilities: {
    toolcall: true,
    attachment: false,
    reasoning: false,
    temperature: true,
    input: { text: true, image: false, audio: false, video: false, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
    interleaved: false,
  },
  api: { id: "test-model", npm: "@ai-sdk/anthropic", url: "https://example.com" },
  options: {},
  headers: {},
  status: "active",
} as const

function setupMocks() {
  Provider.getModel = (async () => mockModel) as unknown as typeof Provider.getModel
  LLM.stream = (async () => ({
    stream: (async function* () {
      yield { type: "text-start" }
      yield { type: "text-delta", text: "基于报告的 follow-up 分析" }
      yield { type: "text-end" }
      yield {
        type: "finish-step",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        providerMetadata: {},
      }
      yield { type: "finish" }
    })(),
  })) as unknown as typeof LLM.stream
}

describe("context sync command lifecycle", () => {
  test("bare /context stores the report without broadcasting session.idle, since it was never busy", async () => {
    await using tmp = await tmpdir({ git: true, config: { model: "test/test-model" } })
    setupMocks()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const events: string[] = []

        // A sync /context never sets busy. It sends session.status idle to reset clients that optimistically went busy,
        // but not session.idle, which would make the desktop show a false "reply ready" notice.
        const offStatus = Bus.subscribe(SessionStatus.Event.Status, (event) => {
          if (event.properties.sessionID !== session.id) return
          if (event.properties.status.type === "idle") events.push("session.status:idle")
        })
        const offIdle = Bus.subscribe(SessionStatus.Event.Idle, (event) => {
          if (event.properties.sessionID !== session.id) return
          events.push("session.idle")
        })

        const result = await SessionRunner.command({
          sessionID: session.id,
          command: "context",
          arguments: "",
          agent: "build",
          model: "test/test-model",
        })

        offStatus()
        offIdle()

        expect(result.info.role).toBe("assistant")
        expect((result.info as Message.AssistantInfo).finish).toBe("stop")
        expect(result.parts[0].type).toBe("text")
        expect((result.parts[0] as Message.TextPart).ignored).toBe(true)
        expect((result.parts[0] as Message.TextPart).text).toContain("上下文")

        const messages = await Session.messages({ sessionID: session.id })
        const user = messages.find((m) => m.info.role === "user")
        const userText = user?.parts.find((p) => p.type === "text") as Message.TextPart | undefined
        expect(userText?.text).toBe("/context")
        expect(userText?.ignored).toBe(true)

        expect(SessionStatus.get(session.id).type).toBe("idle")
        expect(events).toEqual(["session.status:idle"])

        await Session.remove(session.id)
      },
    })
  }, 15000)

  test("/context with a trailing task reports first, then continues with the LLM and ends idle", async () => {
    await using tmp = await tmpdir({ git: true, config: { model: "test/test-model" } })
    setupMocks()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const events: string[] = []
        const offStatus = Bus.subscribe(SessionStatus.Event.Status, (event) => {
          if (event.properties.sessionID !== session.id) return
          if (event.properties.status.type === "idle") events.push("session.status:idle")
        })
        const offIdle = Bus.subscribe(SessionStatus.Event.Idle, (event) => {
          if (event.properties.sessionID !== session.id) return
          events.push("session.idle")
        })

        const result = await SessionRunner.command({
          sessionID: session.id,
          command: "context",
          arguments: "分析一下这个结果",
          agent: "build",
          model: "test/test-model",
        })

        offStatus()
        offIdle()

        expect(result.info.role).toBe("assistant")
        const followupText = result.parts
          .filter((p) => p.type === "text")
          .map((p) => (p as Message.TextPart).text)
          .join("")
        expect(followupText).toContain("基于报告的 follow-up 分析")

        const messages = await Session.messages({ sessionID: session.id })
        const ignoredReports = messages.filter(
          (m) =>
            m.info.role === "assistant" &&
            m.parts.some(
              (p) =>
                p.type === "text" && (p as Message.TextPart).ignored && (p as Message.TextPart).text.includes("上下文"),
            ),
        )
        expect(ignoredReports.length).toBeGreaterThan(0)

        const followupUser = messages.find(
          (m) =>
            m.info.role === "user" &&
            m.parts.some(
              (p) =>
                p.type === "text" &&
                (p as Message.TextPart).text === "分析一下这个结果" &&
                !(p as Message.TextPart).ignored,
            ),
        )
        expect(followupUser).toBeDefined()
        if (followupUser?.info.role === "user") {
          expect(followupUser.info.system).toContain("The user just ran the /context command")
          expect(followupUser.info.system).toContain("上下文")
        }

        // The trailing LLM run goes busy -> idle and broadcasts session.idle exactly once.
        expect(SessionStatus.get(session.id).type).toBe("idle")
        expect(events).toContain("session.status:idle")
        expect(events).toContain("session.idle")
        expect(events.filter((e) => e === "session.idle")).toHaveLength(1)

        await Session.remove(session.id)
      },
    })
  }, 30000)

  test("buildSyncFollowupSystem injects the command output into the system prompt", () => {
    const system = SessionRunner.__test.buildSyncFollowupSystem("context", "## 上下文报告\n\ntokens: 100")
    expect(system).toContain("The user just ran the /context command")
    expect(system).toContain("## 上下文报告")
    expect(system).toContain("tokens: 100")
  })
})
