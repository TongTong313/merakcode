import { afterEach, beforeEach, expect, test } from "vitest"
import { Auth } from "@merakcode/engine/agent/model/credentials"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Provider } from "@merakcode/engine/agent/model/provider"
import { Session } from "@merakcode/engine/agent/session/index"
import { Message } from "@merakcode/engine/agent/session/message"
import { LLM } from "@merakcode/engine/agent/model/llm"
import { Loop } from "@merakcode/engine/agent/loop/index"
import { SessionContextLayer } from "@merakcode/engine/agent/context/context-layer"
import { LoopStatus } from "@merakcode/engine/agent/loop/status"
import { SessionRoutes } from "@merakcode/engine/app/server/routes/session"
import { LoopRequest } from "@merakcode/engine/agent/loop/request"
import { Log } from "@merakcode/log/logger"
import { Plugin } from "@merakcode/engine/agent/plugin/index"
import { tmpdir } from "../fixture/fixture"
import fs from "fs/promises"
import path from "path"
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

test("prompt sent while the session is running queues behind the current task without a concurrent loop", async () => {
  let callCount = 0
  let prompt1StartedResolve: () => void
  const prompt1Started = new Promise<void>((r) => {
    prompt1StartedResolve = r
  })
  let prompt1GateResolve: () => void
  const prompt1Gate = new Promise<void>((r) => {
    prompt1GateResolve = r
  })

  let buildCallCount = 0
  LLM.stream = (async (input: { agent?: { id?: string } }) => {
    const isBuild = input.agent?.id === "build"
    const currentCall = isBuild ? ++buildCallCount : ++callCount
    return {
      stream: (async function* () {
        if (isBuild && currentCall === 1) {
          prompt1StartedResolve()
          await prompt1Gate
        }
        yield { type: "start" }
        yield { type: "text-start", id: `t${currentCall}` }
        yield { type: "text-delta", id: `t${currentCall}`, text: `回复 ${currentCall}` }
        yield { type: "text-end", id: `t${currentCall}` }
        yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: "finish" }
      })(),
    }
  }) as unknown as typeof LLM.stream

  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ title: "Test Session" })

      const p1Promise = Loop.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: "test-provider", modelID: "test-model" },
        parts: [{ type: "text", text: "任务 1" }],
      })

      await prompt1Started
      expect(buildCallCount).toBe(1)
      expect(LoopStatus.get(session.id).type).toBe("busy")

      let p2Settled = false
      const p2Promise = Loop.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: "test-provider", modelID: "test-model" },
        parts: [{ type: "text", text: "任务 2" }],
      }).then((res) => {
        p2Settled = true
        return res
      })

      // Task 2 must stay queued: it may not settle early or start a concurrent LLM call.
      await delay(50)
      expect(p2Settled).toBe(false)
      expect(buildCallCount).toBe(1)

      prompt1GateResolve()
      const r1 = await p1Promise
      expect(r1.info.role).toBe("assistant")
      const r1Text = r1.parts.find((p) => p.type === "text") as any
      expect(r1Text?.text).toBe("回复 1")

      const r2 = await p2Promise
      expect(r2.info.role).toBe("assistant")
      const r2Text = r2.parts.find((p) => p.type === "text") as any
      expect(r2Text?.text).toBe("回复 2")
      expect(buildCallCount).toBe(2)
      await delay(50)
      expect(LoopStatus.get(session.id).type).toBe("idle")

      // Final order and parent links of the message stream.
      const streamMsgs = await Message.filterCompacted(Message.stream(session.id))
      expect(streamMsgs.length).toBe(4)
      expect(streamMsgs[0].info.role).toBe("user")
      expect(streamMsgs[0].parts[0]).toMatchObject({ type: "text", text: "任务 1" })
      expect(streamMsgs[1].info.role).toBe("assistant")
      expect((streamMsgs[1].info as any).parentID).toBe(streamMsgs[0].info.id)
      expect(streamMsgs[2].info.role).toBe("user")
      expect(streamMsgs[2].parts[0]).toMatchObject({ type: "text", text: "任务 2" })
      expect(streamMsgs[3].info.role).toBe("assistant")
      expect((streamMsgs[3].info as any).parentID).toBe(streamMsgs[2].info.id)
    },
  })
}, 20000)

test("prompt queued during a multi-step run keeps message order and gets its own reply", async () => {
  let stepCount = 0
  let step1DoneResolve: () => void
  const step1Done = new Promise<void>((r) => {
    step1DoneResolve = r
  })
  let step2GateResolve: () => void
  const step2Gate = new Promise<void>((r) => {
    step2GateResolve = r
  })

  let turn2LastUserText = ""

  LLM.stream = (async (input: { agent?: { id?: string }; messages?: any[] }) => {
    const isBuild = input.agent?.id === "build"
    if (!isBuild) {
      return {
        stream: (async function* () {
          yield { type: "start" }
          yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }
          yield { type: "finish" }
        })(),
      }
    }

    stepCount++
    const currentStep = stepCount

    if (currentStep === 1) {
      // Task 1, step 1: call a tool.
      return {
        stream: (async function* () {
          yield { type: "start" }
          yield {
            type: "tool-call",
            toolCallId: "call_test_01",
            toolName: "read",
            args: JSON.stringify({ filePath: "sample.txt" }),
          }
          yield { type: "finish-step", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1 } }
          yield { type: "finish" }
          step1DoneResolve()
        })(),
      }
    }

    if (currentStep === 2) {
      // Task 1, step 2: final reply after the tool finishes.
      await step2Gate
      return {
        stream: (async function* () {
          yield { type: "start" }
          yield { type: "text-start", id: "t_turn1_final" }
          yield { type: "text-delta", id: "t_turn1_final", text: "任务1最终完成" }
          yield { type: "text-end", id: "t_turn1_final" }
          yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }
          yield { type: "finish" }
        })(),
      }
    }

    if (currentStep === 3) {
      // Task 2: record the last user message the model receives.
      const userMsgs = (input.messages || []).filter((m: any) => m.role === "user")
      const lastUser = userMsgs.at(-1)
      const lastText = Array.isArray(lastUser?.content)
        ? lastUser.content.find((p: any) => p.type === "text")?.text
        : typeof lastUser?.content === "string"
          ? lastUser.content
          : ""
      turn2LastUserText = lastText || ""

      return {
        stream: (async function* () {
          yield { type: "start" }
          yield { type: "text-start", id: "t_turn2_final" }
          yield { type: "text-delta", id: "t_turn2_final", text: "任务2回答完成" }
          yield { type: "text-end", id: "t_turn2_final" }
          yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }
          yield { type: "finish" }
        })(),
      }
    }

    throw new Error(`Unexpected stepCount: ${currentStep}`)
  }) as unknown as typeof LLM.stream

  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await fs.writeFile(path.join(tmp.path, "sample.txt"), "hello sample content")

      const session = await Session.create({ title: "Multi-Step Test Session" })

      const p1Promise = Loop.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: "test-provider", modelID: "test-model" },
        parts: [{ type: "text", text: "任务 1: 请读取 sample.txt" }],
      })

      await step1Done
      expect(stepCount).toBe(1)

      // Queue task 2 after task 1's tool step and before its second step.
      const p2Promise = Loop.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: "test-provider", modelID: "test-model" },
        parts: [{ type: "text", text: "任务 2: 你是什么模型" }],
      })

      let queuedUser: Message.FullMsg | undefined
      for (let i = 0; i < 20; i++) {
        await delay(50)
        const busyStream = await Message.filterCompacted(Message.stream(session.id))
        queuedUser = busyStream.find((m) => m.info.role === "user" && (m.parts[0] as any)?.text?.includes("任务 2"))
        if (queuedUser) break
      }
      expect(queuedUser).toBeDefined()

      step2GateResolve()

      const r1 = await p1Promise
      const r1Text = r1.parts.find((p) => p.type === "text") as any
      expect(r1Text?.text).toBe("任务1最终完成")

      const r2 = await p2Promise
      const r2Text = r2.parts.find((p) => p.type === "text") as any
      expect(r2Text?.text).toBe("任务2回答完成")

      // Task 2's last user message must be its own prompt, never task 1's content or summary.
      expect(turn2LastUserText).toContain("任务 2: 你是什么模型")

      // Sorted by turn causality, task 2's user message comes after all of task 1's assistant messages.
      const streamMsgs = await Message.filterCompacted(Message.stream(session.id))
      const causalMsgs = SessionContextLayer.sortByTurnCausality(streamMsgs)
      // [User 1, Assistant 1 (step 1 tool), Assistant 2 (step 2 text), User 2, Assistant 3 (turn 2 text)]
      expect(causalMsgs.length).toBe(5)
      expect(causalMsgs[0].parts[0]).toMatchObject({ type: "text", text: "任务 1: 请读取 sample.txt" })
      expect(causalMsgs[1].info.role).toBe("assistant")
      expect((causalMsgs[1].info as any).parentID).toBe(causalMsgs[0].info.id)
      expect(causalMsgs[2].info.role).toBe("assistant")
      expect((causalMsgs[2].info as any).parentID).toBe(causalMsgs[0].info.id)
      expect(causalMsgs[3].info.role).toBe("user")
      expect(causalMsgs[3].parts[0]).toMatchObject({ type: "text", text: "任务 2: 你是什么模型" })
      expect(causalMsgs[4].info.role).toBe("assistant")
      expect((causalMsgs[4].info as any).parentID).toBe(causalMsgs[3].info.id)

      await delay(50)
      expect(LoopStatus.get(session.id).type).toBe("idle")
    },
  })
}, 25000)

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

test("request submitted while an interrupt settles waits for the old run to actually exit", async () => {
  const started = gate()
  const cleanup = gate()
  let calls = 0
  let active = 0
  let maximum = 0
  LLM.stream = (async (input: Parameters<typeof LLM.stream>[0]) => ({
    stream: (async function* () {
      if (input.agent.id !== "build") {
        yield { type: "start" }
        yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: "finish" }
        return
      }
      const index = ++calls
      active++
      maximum = Math.max(maximum, active)
      try {
        yield { type: "start" }
        if (index === 1) {
          started.resolve()
          await new Promise<void>((resolve) => {
            if (input.abort.aborted) return resolve()
            input.abort.addEventListener("abort", () => resolve(), { once: true })
          })
          await cleanup.promise
          throw new Error("stream stopped")
        }
        yield { type: "text-start", id: "successor" }
        yield { type: "text-delta", id: "successor", text: "successor completed" }
        yield { type: "text-end", id: "successor" }
        yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: "finish" }
      } finally {
        active--
      }
    })(),
  })) as unknown as typeof LLM.stream
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const submit = (text: string) =>
        LoopRequest.prompt({
          sessionID: session.id,
          agent: "build",
          model: { providerID: "test-provider", modelID: "test-model" },
          parts: [{ type: "text", text }],
        })
      const first = submit("current").catch((error: unknown) => error)
      await started.promise
      const stopped = Loop.interruptAndSettle(session.id)
      const next = submit("successor")
      try {
        await queued(session.id, 2)
        expect(calls).toBe(1)
        expect(() => Loop.assertNotBusy(session.id)).toThrow(Session.BusyError)
        cleanup.resolve()
        await stopped
        expect(await first).toMatchObject({ name: "AbortError" })
        expect((await next).parts.find((part) => part.type === "text")).toMatchObject({ text: "successor completed" })
        expect(calls).toBe(2)
        expect(maximum).toBe(1)
        expect(LoopStatus.get(session.id).type).toBe("idle")
      } finally {
        cleanup.resolve()
        await Loop.cancelTree(session.id)
        await Promise.allSettled([first, next])
      }
    },
  })
}, 20_000)

async function queued(sessionID: string, count: number) {
  // Wait by time, not attempts: on a busy machine message writes are slow and 100 polls last only a second or two.
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const messages = await Message.filterCompacted(Message.stream(sessionID))
    if (messages.filter((message) => message.info.role === "user").length === count) {
      // Message creation precedes the remaining prompt preparation and queue admission.
      await delay(30)
      return
    }
    await delay(10)
  }
  throw new Error(`Expected ${count} admitted user messages`)
}

// client.session.abort interrupts the current turn; inputs already accepted keep running in FIFO order.
test.each(["direct", "http", "scoped-http"] as const)(
  "%s: interrupt runs the queue next; repeated interrupts keep FIFO and wait for the previous turn to exit",
  async (entry) => {
    const starts = [gate(), gate()]
    const cleanups = [gate(), gate()]
    const calls: string[] = []
    let active = 0
    let maximum = 0
    LLM.stream = (async (input: Parameters<typeof LLM.stream>[0]) => ({
      stream: (async function* () {
        if (input.agent.id !== "build") {
          yield { type: "start" }
          yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }
          yield { type: "finish" }
          return
        }
        const user = input.messages.findLast((message) => message.role === "user")
        const text =
          typeof user?.content === "string"
            ? user.content
            : (user?.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n") ?? "")
        const index = calls.length
        calls.push(text)
        active++
        maximum = Math.max(maximum, active)
        try {
          yield { type: "start" }
          if (index < 2) {
            starts[index].resolve()
            await new Promise<void>((resolve) => {
              if (input.abort.aborted) return resolve()
              input.abort.addEventListener("abort", () => resolve(), { once: true })
            })
            await cleanups[index].promise
            throw new Error("stream stopped")
          }
          yield { type: "text-start", id: `queue-${index}` }
          yield { type: "text-delta", id: `queue-${index}`, text: `完成 ${index + 1}` }
          yield { type: "text-end", id: `queue-${index}` }
          yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }
          yield { type: "finish" }
        } finally {
          active--
        }
      })(),
    })) as unknown as typeof LLM.stream

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const interrupt = async () => {
          if (entry === "direct") return Loop.interruptAndSettle(session.id)
          const response = await SessionRoutes().request(`/${session.id}/abort`, { method: "POST" })
          expect(response.status).toBe(200)
          expect(await response.json()).toBe(true)
        }
        const submit = (index: number) =>
          (entry === "scoped-http" ? LoopRequest.prompt : Loop.prompt)({
            sessionID: session.id,
            agent: "build",
            model: { providerID: "test-provider", modelID: "test-model" },
            parts: [{ type: "text", text: `排队任务 ${index}` }],
          }).then(
            (message) => ({ message, error: undefined }),
            (error: unknown) => ({ message: undefined, error }),
          )
        const first = submit(1)
        await starts[0].promise
        const second = submit(2)
        await queued(session.id, 2)
        const third = submit(3)
        await queued(session.id, 3)
        try {
          const stop = interrupt()
          // A request arriving during cancellation joins the reserved owner behind the existing queue.
          const fourth = submit(4)
          await queued(session.id, 4)
          expect(calls).toHaveLength(1)
          expect(() => Loop.assertNotBusy(session.id)).toThrow(Session.BusyError)
          cleanups[0].resolve()
          await stop
          await starts[1].promise
          const stopNext = interrupt()
          expect(calls).toHaveLength(2)
          cleanups[1].resolve()
          await stopNext

          const results = await Promise.all([first, second, third, fourth])
          if (entry === "scoped-http") {
            expect(results[0].error).toMatchObject({ name: "AbortError" })
            expect(results[1].error).toMatchObject({ name: "AbortError" })
          } else {
            expect(results[0].error).toBeInstanceOf(Message.AbortedError)
            expect(results[1].error).toBeInstanceOf(Message.AbortedError)
          }
          for (const [index, result] of results.entries()) {
            if (index < 2) continue
            expect(result.error).toBeUndefined()
            expect(result.message?.parts.find((part) => part.type === "text")).toMatchObject({
              text: `完成 ${index + 1}`,
            })
          }
          expect(calls.map((text) => text.match(/排队任务 \d/)?.[0])).toEqual([
            "排队任务 1",
            "排队任务 2",
            "排队任务 3",
            "排队任务 4",
          ])
          expect(maximum).toBe(1)
          const messages = await Message.filterCompacted(Message.stream(session.id))
          const users = messages.filter((message) => message.info.role === "user")
          for (const user of users) {
            const answers = messages.filter(
              (message) => message.info.role === "assistant" && message.info.parentID === user.info.id,
            )
            expect(answers).toHaveLength(1)
          }
          await delay(30)
          expect(LoopStatus.get(session.id).type).toBe("idle")
          expect(() => Loop.assertNotBusy(session.id)).not.toThrow()
        } finally {
          cleanups.forEach((cleanup) => cleanup.resolve())
          await Loop.cancelAndSettle(session.id)
        }
      },
    })
  },
  20000,
)

test.each([false, true])(
  "hard stop of the session tree cancels queued requests instead of starting a new turn (interrupt handoff: %s)",
  async (handoff) => {
    const started = gate()
    const cleanup = gate()
    let calls = 0
    LLM.stream = (async (input: Parameters<typeof LLM.stream>[0]) => ({
      stream: (async function* () {
        calls++
        yield { type: "start" }
        started.resolve()
        await new Promise<void>((resolve) => {
          if (input.abort.aborted) return resolve()
          input.abort.addEventListener("abort", () => resolve(), { once: true })
        })
        if (handoff) await cleanup.promise
        throw new Error("stream stopped")
      })(),
    })) as unknown as typeof LLM.stream

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const submit = (text: string) =>
          Loop.prompt({
            sessionID: session.id,
            agent: "build",
            model: { providerID: "test-provider", modelID: "test-model" },
            parts: [{ type: "text", text }],
          }).catch((error: unknown) => error)
        const first = submit("当前任务")
        await started.promise
        const second = submit("排队任务")
        await queued(session.id, 2)
        const interrupted = handoff ? Loop.interruptAndSettle(session.id) : undefined
        const stopped = Loop.cancelTree(session.id)
        cleanup.resolve()
        await Promise.all([interrupted, stopped])
        expect(await first).toBeInstanceOf(Message.AbortedError)
        expect(await second).toBeInstanceOf(Message.AbortedError)
        expect(calls).toBe(1)
        expect(LoopStatus.get(session.id).type).toBe("idle")
        expect(() => Loop.assertNotBusy(session.id)).not.toThrow()
      },
    })
  },
  20000,
)

// A hard stop between writing a message and queueing it must not let that message run afterwards.
// experimental.chat.guard (the last hook after the write and before queueing) holds it in that window without timing.
test.each(["direct", "dispatch"] as const)(
  "message written but not yet queued at a hard stop does not run afterwards (%s)",
  async (entry) => {
    const started = gate()
    const held = gate()
    const release = gate()
    let calls = 0
    LLM.stream = (async (input: Parameters<typeof LLM.stream>[0]) => ({
      stream: (async function* () {
        if (input.agent.id !== "build") {
          yield { type: "start" }
          yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }
          yield { type: "finish" }
          return
        }
        calls++
        if (calls > 1) throw new Error("another turn ran after the hard stop")
        yield { type: "start" }
        started.resolve()
        await new Promise<void>((resolve) => {
          if (input.abort.aborted) return resolve()
          input.abort.addEventListener("abort", () => resolve(), { once: true })
        })
        throw new Error("stream stopped")
      })(),
    })) as unknown as typeof LLM.stream
    const trigger = Plugin.trigger
    Plugin.trigger = (async (name, input, output) => {
      if (name === "experimental.chat.guard" && JSON.stringify(input).includes("待入队任务")) {
        held.resolve()
        await release.promise
      }
      return trigger(name, input, output)
    }) as typeof Plugin.trigger

    await using tmp = await tmpdir({ git: true })
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const input = (text: string) => ({
            sessionID: session.id,
            agent: "build",
            model: { providerID: "test-provider", modelID: "test-model" },
            parts: [{ type: "text" as const, text }],
          })
          const submit = (text: string) =>
            (entry === "direct" ? Loop.prompt(input(text)) : LoopRequest.prompt(input(text))).catch(
              (error: unknown) => error,
            )
          const aborted = (error: unknown) =>
            error instanceof Message.AbortedError || (error instanceof Error && error.name === "AbortError")
          const first = submit("当前任务")
          await started.promise
          const second = submit("待入队任务")
          await held.promise
          await Loop.cancelTree(session.id)
          release.resolve()
          expect(aborted(await first)).toBe(true)
          expect(aborted(await second)).toBe(true)
          expect(calls).toBe(1)
          expect(LoopStatus.get(session.id).type).toBe("idle")
          expect(() => Loop.assertNotBusy(session.id)).not.toThrow()
          // The written message must be closed as cancelled, or the next turn picks it up as an unanswered request.
          const messages = await Message.filterCompacted(Message.stream(session.id))
          const answered = new Set(
            messages.flatMap((item) => (item.info.role === "assistant" ? [item.info.parentID] : [])),
          )
          expect(messages.filter((item) => item.info.role === "user" && !answered.has(item.info.id))).toEqual([])
        },
      })
    } finally {
      release.resolve()
      Plugin.trigger = trigger
    }
  },
  20000,
)

// An interrupt stops only the current turn: a message in the same window is accepted input and runs afterwards.
test("message written but not yet queued at an interrupt still runs afterwards", async () => {
  const started = gate()
  const held = gate()
  const release = gate()
  let calls = 0
  LLM.stream = (async (input: Parameters<typeof LLM.stream>[0]) => ({
    stream: (async function* () {
      if (input.agent.id !== "build") {
        yield { type: "start" }
        yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: "finish" }
        return
      }
      const index = ++calls
      yield { type: "start" }
      if (index === 1) {
        started.resolve()
        await new Promise<void>((resolve) => {
          if (input.abort.aborted) return resolve()
          input.abort.addEventListener("abort", () => resolve(), { once: true })
        })
        throw new Error("stream stopped")
      }
      yield { type: "text-start", id: "successor" }
      yield { type: "text-delta", id: "successor", text: "successor completed" }
      yield { type: "text-end", id: "successor" }
      yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: "finish" }
    })(),
  })) as unknown as typeof LLM.stream
  const trigger = Plugin.trigger
  Plugin.trigger = (async (name, input, output) => {
    if (name === "experimental.chat.guard" && JSON.stringify(input).includes("待入队任务")) {
      held.resolve()
      await release.promise
    }
    return trigger(name, input, output)
  }) as typeof Plugin.trigger

  await using tmp = await tmpdir({ git: true })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const submit = (text: string) =>
          Loop.prompt({
            sessionID: session.id,
            agent: "build",
            model: { providerID: "test-provider", modelID: "test-model" },
            parts: [{ type: "text", text }],
          }).catch((error: unknown) => error)
        const first = submit("当前任务")
        await started.promise
        const second = submit("待入队任务")
        await held.promise
        const stopped = Loop.interruptAndSettle(session.id)
        release.resolve()
        await stopped
        expect(await first).toBeInstanceOf(Message.AbortedError)
        const next = (await second) as Message.FullMsg
        expect(next.parts.find((part) => part.type === "text")).toMatchObject({ text: "successor completed" })
        expect(calls).toBe(2)
        expect(LoopStatus.get(session.id).type).toBe("idle")
      },
    })
  } finally {
    release.resolve()
    Plugin.trigger = trigger
  }
}, 20000)
