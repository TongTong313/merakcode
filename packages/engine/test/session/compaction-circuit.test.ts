import { describe, expect, test } from "vitest"
import { SessionCompaction } from "@merakcode/engine/agent/context/compaction"
import { Session } from "@merakcode/engine/agent/session/index"
import { Message } from "@merakcode/engine/agent/session/message"
import { Bus } from "@merakcode/engine/infra/bus/index"
import { Log } from "@merakcode/log/logger"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Identifier } from "@merakcode/util/id"
import { tmpdir } from "../fixture/fixture"
import type { Provider } from "@merakcode/engine/agent/model/provider"

Log.init({ print: false })

function createModel(opts: { context: number; output: number; input?: number }): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: { context: opts.context, input: opts.input, output: opts.output },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

/**
 * The circuit breaker counter is an in-memory Map keyed by sessionID. Each test uses its own sessionID and resets it
 * at the end so tests don't leak into each other.
 */
describe("session.compaction.circuit-breaker", () => {
  test("recordCompactionResult accumulates failures and clears on success", async () => {
    const id = "circuit-test-accumulate"
    SessionCompaction.resetCompactionFailures(id)

    SessionCompaction.recordCompactionResult(id, false)
    SessionCompaction.recordCompactionResult(id, false)
    expect(await SessionCompaction.isCompactionTripped(id)).toBe(false)

    SessionCompaction.recordCompactionResult(id, false) // third failure trips the breaker
    expect(await SessionCompaction.isCompactionTripped(id)).toBe(true)

    SessionCompaction.recordCompactionResult(id, true) // success clears the count
    expect(await SessionCompaction.isCompactionTripped(id)).toBe(false)

    SessionCompaction.resetCompactionFailures(id)
  })

  test("resetCompactionFailures clears the tripped state", async () => {
    const id = "circuit-test-reset"
    SessionCompaction.resetCompactionFailures(id)
    for (let i = 0; i < 3; i++) SessionCompaction.recordCompactionResult(id, false)
    expect(await SessionCompaction.isCompactionTripped(id)).toBe(true)

    SessionCompaction.resetCompactionFailures(id)
    expect(await SessionCompaction.isCompactionTripped(id)).toBe(false)
  })

  test("sessions are tracked independently", async () => {
    const a = "circuit-test-isolate-a"
    const b = "circuit-test-isolate-b"
    SessionCompaction.resetCompactionFailures(a)
    SessionCompaction.resetCompactionFailures(b)

    for (let i = 0; i < 3; i++) SessionCompaction.recordCompactionResult(a, false)
    expect(await SessionCompaction.isCompactionTripped(a)).toBe(true)
    expect(await SessionCompaction.isCompactionTripped(b)).toBe(false)

    SessionCompaction.resetCompactionFailures(a)
    SessionCompaction.resetCompactionFailures(b)
  })

  test("failureThreshold is configurable", async () => {
    await using tmp = await tmpdir({
      config: { compaction: { failureThreshold: 1 } } as any,
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const id = "circuit-test-threshold"
        SessionCompaction.resetCompactionFailures(id)
        SessionCompaction.recordCompactionResult(id, false)
        expect(await SessionCompaction.isCompactionTripped(id)).toBe(true)
        SessionCompaction.resetCompactionFailures(id)
      },
    })
  })
})

/**
 * fallbackPrune uses protect=8k/minimum=4k, more aggressive than the default 40k/20k. Prune walks backwards and only
 * starts counting after 2 turns; tool results are marked once their accumulated tokens exceed protect, and the pruned
 * total must exceed minimum before anything is written.
 */
describe("session.compaction.fallbackPrune", () => {
  test("clears old tool results using the aggressive thresholds", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sessionID = session.id

        // ~15k tokens per tool result (4 chars/token), well above the fallback protect=8k
        const bigOutput = "x".repeat(60_000)

        // Prune only counts after 2 turns, so the third turn makes the first two turns' tool results prunable.
        for (let turn = 1; turn <= 3; turn++) {
          const userMsg = await Session.updateInfo({
            id: Identifier.ascending("message"),
            role: "user",
            sessionID,
            agent: "default",
            model: { providerID: "openai", modelID: "gpt-4" },
            time: { created: Date.now() },
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: userMsg.id,
            sessionID,
            type: "text",
            text: `turn ${turn}`,
          })
          const assistantMsg = await Session.updateInfo({
            id: Identifier.ascending("message"),
            role: "assistant",
            sessionID,
            mode: "default",
            agent: "default",
            path: { cwd: tmp.path, root: tmp.path },
            cost: 0,
            tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "gpt-4",
            providerID: "openai",
            parentID: userMsg.id,
            time: { created: Date.now() },
            finish: "tool-calls",
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: assistantMsg.id,
            sessionID,
            type: "tool",
            tool: "bash",
            callID: `call_${turn}`,
            state: {
              status: "completed",
              input: {},
              output: bigOutput,
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 0 },
            },
          } as Message.ToolPart)
        }

        await SessionCompaction.fallbackPrune({ sessionID })

        // Cleared tool results carry a compacted timestamp.
        const msgs = await Session.messages({ sessionID })
        let clearedCount = 0
        for (const msg of msgs) {
          for (const part of msg.parts) {
            if (part.type !== "tool") continue
            const state = (part as Message.ToolPart).state
            if (state.status === "completed" && state.time.compacted) clearedCount++
          }
        }
        expect(clearedCount).toBeGreaterThan(0)
      },
    })
  })

  test("fallbackPrune does nothing when prune=false, leaving large tool output uncompacted", async () => {
    await using tmp = await tmpdir({
      config: { compaction: { prune: false } } as any,
      git: true,
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sessionID = session.id
        // Same setup as the previous test: enough tool output to trigger fallbackPrune.
        const bigOutput = "x".repeat(60_000)
        for (let turn = 1; turn <= 3; turn++) {
          const userMsg = await Session.updateInfo({
            id: Identifier.ascending("message"),
            role: "user",
            sessionID,
            agent: "default",
            model: { providerID: "openai", modelID: "gpt-4" },
            time: { created: Date.now() },
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: userMsg.id,
            sessionID,
            type: "text",
            text: `turn ${turn}`,
          })
          const assistantMsg = await Session.updateInfo({
            id: Identifier.ascending("message"),
            role: "assistant",
            sessionID,
            mode: "default",
            agent: "default",
            path: { cwd: tmp.path, root: tmp.path },
            cost: 0,
            tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "gpt-4",
            providerID: "openai",
            parentID: userMsg.id,
            time: { created: Date.now() },
            finish: "tool-calls",
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: assistantMsg.id,
            sessionID,
            type: "tool",
            tool: "bash",
            callID: `call_${turn}`,
            state: {
              status: "completed",
              input: {},
              output: bigOutput,
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 0 },
            },
          } as Message.ToolPart)
        }

        await SessionCompaction.fallbackPrune({ sessionID })

        // The prune=false guard returns early, so no tool result is compacted.
        const msgs = await Session.messages({ sessionID })
        for (const msg of msgs) {
          for (const part of msg.parts) {
            if (part.type !== "tool") continue
            const state = (part as Message.ToolPart).state
            if (state.status === "completed") {
              expect(state.time.compacted).toBeUndefined()
              expect(state.output).toBe(bigOutput)
            }
          }
        }
      },
    })
  })
})

/**
 * tripBlockingLimit publishes CompactionBlockedError and sets the session idle. Bus.subscribe callbacks receive
 * { type, properties: { sessionID, error } }.
 */
describe("session.compaction.tripBlockingLimit", () => {
  test("publishes a CompactionBlockedError event", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sessionID = session.id
        const model = createModel({ context: 100_000, output: 32_000 })

        let captured: any = undefined
        const off = Bus.subscribe(Session.Event.Error, (event) => {
          if (event.properties.sessionID === sessionID) captured = event.properties.error
        })

        await SessionCompaction.tripBlockingLimit({ sessionID, tokens: 120_000, model })
        off()

        expect(captured).toBeDefined()
        expect(captured.name).toBe("CompactionBlockedError")
        expect(captured.data.tokens).toBe(120_000)
      },
    })
  })

  test("publishes no error when blockingLimit=false", async () => {
    await using tmp = await tmpdir({
      config: { compaction: { blockingLimit: false } } as any,
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sessionID = session.id
        const model = createModel({ context: 100_000, output: 32_000 })

        let captured: any = undefined
        const off = Bus.subscribe(Session.Event.Error, (event) => {
          if (event.properties.sessionID === sessionID) captured = event.properties.error
        })

        await SessionCompaction.tripBlockingLimit({ sessionID, tokens: 120_000, model })
        off()

        expect(captured).toBeUndefined()
      },
    })
  })
})
