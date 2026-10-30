import { afterEach, beforeEach, expect, test } from "vitest"
import { Auth } from "@merakcode/engine/agent/model/credentials"
import { Bus } from "@merakcode/engine/infra/bus/index"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Provider } from "@merakcode/engine/agent/model/provider"
import { Question } from "@merakcode/engine/agent/session/question/index"
import { Session } from "@merakcode/engine/agent/session/index"
import { LLM } from "@merakcode/engine/agent/model/llm"
import { Loop } from "@merakcode/engine/agent/loop/index"
import { LoopStatus } from "@merakcode/engine/agent/loop/status"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"

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
    api: { id: "test-model" },
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

async function prompt(sessionID: string) {
  return Loop.prompt({
    sessionID,
    agent: "build",
    model: { providerID: "test-provider", modelID: "test-model" },
    parts: [{ type: "text", text: "检查文件" }],
  })
}

test("model stream error publishes only the original error, not an extra interrupt from owner cleanup", async () => {
  LLM.stream = (async () => ({
    stream: (async function* () {
      yield { type: "start" }
      throw new Error("provider stream failed")
    })(),
  })) as unknown as typeof LLM.stream

  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const errors: Array<{ name?: string; data?: unknown }> = []
      const unsubscribe = Bus.subscribe(Session.Event.Error, (event) => {
        if (event.properties.sessionID === session.id && event.properties.error) errors.push(event.properties.error)
      })
      try {
        const pending = Question.ask({
          sessionID: session.id,
          questions: [{ question: "继续吗？", header: "继续", options: [{ label: "是", description: "继续" }] }],
        }).then(
          () => undefined,
          (error: unknown) => error,
        )
        expect(await Question.list()).toHaveLength(1)
        const result = await prompt(session.id)
        if (result.info.role !== "assistant") throw new Error("expected assistant message")
        expect(result.info.error?.name).toBe("UnknownError")
        expect(errors.map((error) => error.name)).toEqual(["UnknownError"])
        expect(errors[0]?.data).toMatchObject({ message: "Error: provider stream failed" })
        expect(await pending).toBeInstanceOf(Question.AbortedError)
        expect(await Question.list()).toEqual([])
        expect(LoopStatus.get(session.id).type).toBe("idle")
        expect(() => Loop.assertNotBusy(session.id)).not.toThrow()
      } finally {
        unsubscribe()
      }
    },
  })
}, 15000)

test("normal completion publishes no false interrupt", async () => {
  LLM.stream = (async () => ({
    stream: (async function* () {
      yield { type: "start" }
      yield { type: "text-start", id: "t1" }
      yield { type: "text-delta", id: "t1", text: "完成" }
      yield { type: "text-end", id: "t1" }
      yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: "finish" }
    })(),
  })) as unknown as typeof LLM.stream

  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const errors: string[] = []
      const unsubscribe = Bus.subscribe(Session.Event.Error, (event) => {
        if (event.properties.sessionID === session.id && event.properties.error)
          errors.push(event.properties.error.name)
      })
      try {
        const result = await prompt(session.id)
        if (result.info.role !== "assistant") throw new Error("expected assistant message")
        expect(result.info.error).toBeUndefined()
        expect(errors).toEqual([])
        expect(LoopStatus.get(session.id).type).toBe("idle")
      } finally {
        unsubscribe()
      }
    },
  })
}, 15000)

test("explicit user Stop still interrupts and waits for the owner to settle", async () => {
  let entered!: () => void
  const streaming = new Promise<void>((resolve) => {
    entered = resolve
  })
  LLM.stream = (async (input: Parameters<typeof LLM.stream>[0]) => ({
    stream: (async function* () {
      yield { type: "start" }
      entered()
      await new Promise<void>((resolve) => {
        if (input.abort.aborted) return resolve()
        input.abort.addEventListener("abort", () => resolve(), { once: true })
      })
      throw new Error("stream stopped")
    })(),
  })) as unknown as typeof LLM.stream

  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const errors: string[] = []
      const unsubscribe = Bus.subscribe(Session.Event.Error, (event) => {
        if (event.properties.sessionID === session.id && event.properties.error)
          errors.push(event.properties.error.name)
      })
      try {
        const running = prompt(session.id)
        await streaming
        const pending = Question.ask({
          sessionID: session.id,
          questions: [{ question: "继续吗？", header: "继续", options: [{ label: "是", description: "继续" }] }],
        }).then(
          () => undefined,
          (error: unknown) => error,
        )
        expect(await Question.list()).toHaveLength(1)
        await Loop.cancelAndSettle(session.id)
        const result = await running
        if (result.info.role !== "assistant") throw new Error("expected assistant message")
        expect(result.info.error?.name).toBe("MessageAbortedError")
        expect(errors).toContain("MessageAbortedError")
        expect(errors.every((name) => name === "MessageAbortedError")).toBe(true)
        expect(await pending).toBeInstanceOf(Question.AbortedError)
        expect(await Question.list()).toEqual([])
        expect(LoopStatus.get(session.id).type).toBe("idle")
        expect(() => Loop.assertNotBusy(session.id)).not.toThrow()
      } finally {
        unsubscribe()
      }
    },
  })
}, 15000)
