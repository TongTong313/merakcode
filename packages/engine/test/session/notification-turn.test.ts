/**
 * A notification (a background workflow finished) arrives while the session is idle: the deliverer starts the loop,
 * the model receives the notification and replies, and the notification is then acknowledged.
 */
import { afterEach, beforeEach, expect, test } from "vitest"
import { Auth } from "@merakcode/engine/auth/index"
import { Instance } from "@merakcode/engine/project/instance"
import { Provider } from "@merakcode/engine/provider/provider"
import { Session } from "@merakcode/engine/session/index"
import { Message } from "@merakcode/engine/session/message"
import { LLM } from "@merakcode/engine/session/llm"
import { SessionNotification } from "@merakcode/engine/session/notification"
import { SessionNotificationDelivery } from "@merakcode/engine/session/notification-delivery"
import { SessionRunner } from "@merakcode/engine/session/runner"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"
import { setTimeout as delay } from "node:timers/promises"

Log.init({ print: false })

const originalStream = LLM.stream
const originalGetModel = Provider.getModel
const originalGetProvider = Provider.getProvider
const originalGetAuth = Auth.get

beforeEach(() => {
  Provider.getModel = (async () => ({
    id: "test-model",
    providerID: "test-provider",
    modelID: "test-model",
    api: { id: "test-model", npm: "@ai-sdk/openai-compatible" },
    limit: { context: 128000, output: 8192 },
  })) as unknown as typeof Provider.getModel
  Provider.getProvider = (async () => ({ id: "test-provider", options: {} })) as unknown as typeof Provider.getProvider
  Auth.get = (async () => undefined) as unknown as typeof Auth.get
})

afterEach(() => {
  LLM.stream = originalStream
  Provider.getModel = originalGetModel
  Provider.getProvider = originalGetProvider
  Auth.get = originalGetAuth
})

test("notification to an idle session starts a turn, reaches the model, and is acknowledged after the reply", async () => {
  const prompts: string[] = []
  LLM.stream = (async (input: Parameters<typeof LLM.stream>[0]) => {
    const user = input.messages.findLast((message) => message.role === "user")
    const text =
      typeof user?.content === "string"
        ? user.content
        : (user?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
    if (input.agent.id === "build") prompts.push(text)
    const reply = text.includes("WORKFLOW_DONE") ? "收到工作流结果" : "第一轮"
    return {
      stream: (async function* () {
        yield { type: "start" }
        yield { type: "text-start", id: "t" }
        yield { type: "text-delta", id: "t", text: reply }
        yield { type: "text-end", id: "t" }
        yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: "finish" }
      })(),
    }
  }) as unknown as typeof LLM.stream

  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await SessionRunner.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: "test-provider", modelID: "test-model" },
        parts: [{ type: "text", text: "开始" }],
      })
      await SessionNotification.enqueue({
        sessionID: session.id,
        type: "workflow.finished",
        text: "WORKFLOW_DONE 两个任务都完成了",
        agent: "build",
        model: { providerID: "test-provider", modelID: "test-model" },
      })
      SessionNotificationDelivery.request(session.id, { delay: 0 })
      const deadline = Date.now() + 15_000
      for (;;) {
        const messages = await Message.filterCompacted(Message.stream(session.id))
        const answered = messages.some(
          (message) =>
            message.info.role === "assistant" &&
            message.parts.some((part) => part.type === "text" && part.text === "收到工作流结果"),
        )
        if (answered && (await SessionNotification.list(session.id)).length === 0) break
        if (Date.now() > deadline)
          throw new Error(`notification was not delivered; model received: ${JSON.stringify(prompts)}`)
        await delay(50)
      }
      expect(prompts.at(-1)).toContain("WORKFLOW_DONE")
    },
  })
}, 30_000)
