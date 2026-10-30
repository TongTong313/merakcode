/**
 * End-to-end wiring of retryCount in the Loop.prompt loop (shouldRetryStructuredOutput itself is unit-tested
 * separately). The mocked model always replies with plain text and stops, never calling the StructuredOutput tool:
 *   1) without structured output, each retry appends a synthetic user prompt carrying the format;
 *   2) after the retry limit the run ends with an explicit StructuredOutputError instead of degrading silently;
 *   3) retries are bounded (retryCount=1 means exactly one synthetic prompt, never an endless loop).
 * Only workflow agent({schema}) uses structured output, so this path affects workflow child sessions, not chat.
 */
import { afterEach, beforeEach, test, expect } from "vitest"
import { Provider } from "@merakcode/engine/agent/model/provider"
import { Session } from "@merakcode/engine/agent/session/index"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Loop } from "@merakcode/engine/agent/loop/index"
import { Message } from "@merakcode/engine/agent/session/message"
import { LLM } from "@merakcode/engine/agent/model/llm"
import { Log } from "@merakcode/log/logger"
import { LoopStatus } from "@merakcode/engine/agent/loop/status"
import { tmpdir } from "../fixture/fixture"
import { setTimeout as delay } from "node:timers/promises"

Log.init({ print: false })

const realStream = LLM.stream
const realGetModel = Provider.getModel

const RETRY_PROMPT = "You did not call the StructuredOutput tool"

beforeEach(() => {
  // Plain text and stop every time, so StructuredOutput is never called and the retry path runs.
  LLM.stream = (async () => ({
    stream: (async function* () {
      yield { type: "text-start" }
      yield { type: "text-delta", text: "plain text, not structured" }
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
  Provider.getModel = (async () => ({
    id: "test-model",
    providerID: "test-provider",
    modelID: "test-model",
    api: { id: "test-model" },
    limit: { context: 128000, output: 8192 },
  })) as unknown as typeof Provider.getModel
})

afterEach(() => {
  LLM.stream = realStream
  Provider.getModel = realGetModel
})

test("missing structured output retries with a correction prompt, then fails with StructuredOutputError", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const result = await Loop.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: "test-provider", modelID: "test-model" },
        format: {
          type: "json_schema",
          schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
          retryCount: 1,
        },
        parts: [{ type: "text", text: "Return a name as JSON." }],
      })

      expect((result.info as { error?: { name?: string } }).error?.name).toBe("StructuredOutputError")

      // retryCount=1 injects exactly one synthetic user message with the correction prompt.
      let retryInjections = 0
      for await (const msg of Message.stream(session.id)) {
        if (msg.info.role === "user" && msg.parts.some((p) => p.type === "text" && p.text.includes(RETRY_PROMPT))) {
          retryInjections++
        }
      }
      expect(retryInjections).toBe(1)
    },
  })
}, 30000)

test("structured retries keep queued messages out of their context, and each call gets its own result", async () => {
  const firstStarted = Promise.withResolvers<void>()
  const finishFirst = Promise.withResolvers<void>()
  const finishQueued = Promise.withResolvers<void>()
  const contexts: string[] = []
  const backgroundStream = LLM.stream
  LLM.stream = (async (input: LLM.StreamInput) => {
    if (input.agent.id !== "build") return backgroundStream(input)
    const call = contexts.push(JSON.stringify(input.messages))
    return {
      stream: (async function* () {
        if (call === 1) {
          firstStarted.resolve()
          await finishFirst.promise
        }
        if (call === 3) await finishQueued.promise
        yield { type: "text-start", id: `text-${call}` }
        yield { type: "text-delta", id: `text-${call}`, text: `response-${call}` }
        yield { type: "text-end", id: `text-${call}` }
        yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: "finish" }
      })(),
    }
  }) as unknown as typeof LLM.stream

  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ title: "Structured retry queue" })
      const first = Loop.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: "test-provider", modelID: "test-model" },
        format: {
          type: "json_schema",
          schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
          retryCount: 1,
        },
        parts: [{ type: "text", text: "Return a name as JSON." }],
      })
      await firstStarted.promise
      const queuedText = "QUEUED_INDEPENDENT_PROMPT"
      const queued = Loop.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: "test-provider", modelID: "test-model" },
        parts: [{ type: "text", text: queuedText }],
      })
      try {
        // Wait for real persistence so the retry must distinguish the queued
        // prompt from its own later synthetic user message.
        let queuedUser: Message.FullMsg | undefined
        for (let attempt = 0; attempt < 200; attempt++) {
          queuedUser = (await Session.messages({ sessionID: session.id })).find(
            (message) =>
              message.info.role === "user" &&
              message.parts.some((part) => part.type === "text" && part.text === queuedText),
          )
          if (queuedUser) break
          await delay(10)
        }
        expect(queuedUser).toBeDefined()
        finishFirst.resolve()
        const result = await first
        expect(result.info.role === "assistant" && result.info.error?.name).toBe("StructuredOutputError")
        expect(result.parts.some((part) => part.type === "text" && part.text === "response-2")).toBe(true)
        expect(contexts[1]).toContain(RETRY_PROMPT)
        expect(contexts[1]).not.toContain(queuedText)
        expect(LoopStatus.get(session.id).type).toBe("busy")

        finishQueued.resolve()
        const queuedResult = await queued
        expect(queuedResult.info.role === "assistant" && queuedResult.info.parentID).toBe(queuedUser!.info.id)
        expect(queuedResult.parts.some((part) => part.type === "text" && part.text === "response-3")).toBe(true)
        expect(contexts).toHaveLength(3)
        expect(contexts[2]).toContain(queuedText)
        expect(LoopStatus.get(session.id).type).toBe("idle")
      } finally {
        finishFirst.resolve()
        finishQueued.resolve()
        await Loop.cancelAndSettle(session.id)
        await Promise.allSettled([first, queued])
      }
    },
  })
}, 30000)
