import { beforeEach, afterEach, expect, test } from "vitest"
import { LLM } from "@merakcode/engine/agent/model/llm"

const stream = LLM.stream

beforeEach(async () => {
  LLM.stream = async () =>
    ({
      stream: (async function* () {
        yield { type: "text-start" }
        yield { type: "text-delta", text: "summary" }
        yield { type: "text-end" }
        yield {
          type: "finish-step",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          providerMetadata: {},
        }
        yield { type: "finish" }
      })(),
    }) as unknown as Awaited<ReturnType<typeof LLM.stream>>
})

afterEach(() => {
  LLM.stream = stream
})

/**
 * SessionCompaction.process() on a session that was already compacted once, with many completed tool parts on both
 * sides of the summary boundary. Unlike prune(), the SessionContextBudget.applyToProjection budget pass in process()
 * doesn't stop at the summary boundary and scans back to the oldest message. This checks that the scan still finishes
 * correctly and quickly on a large history, not the trim range at the boundary (a known trade-off, see compaction.ts).
 */
test("SessionCompaction.process completes on a large multi-boundary history without slowdown or errors", async () => {
  const { Identifier } = await import("@merakcode/util/id")
  const { Instance } = await import("@merakcode/engine/infra/project/instance")
  const { Session } = await import("@merakcode/engine/agent/session/index")
  const { SessionCompaction } = await import("@merakcode/engine/agent/context/compaction")
  const { Log } = await import("@merakcode/log/logger")
  const { tmpdir } = await import("../fixture/fixture")

  Log.init({ print: false })

  await using tmp = await tmpdir({
    config: {
      provider: {
        "test-provider": {
          name: "Test Provider",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: {
            "test-model": {
              name: "Test Model",
              tool_call: true,
              limit: { context: 128000, output: 4096 },
            },
          },
          options: { apiKey: "test-key" },
        },
      },
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const model = { providerID: "test-provider", modelID: "test-model" }
      const bigOutput = "x".repeat(20000) // ~5k tokens each

      // History before the previous compaction boundary: many completed tool parts from long-term use.
      for (let i = 0; i < 500; i++) {
        const u = await Session.updateInfo({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model,
          time: { created: Date.now() },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: u.id,
          sessionID: session.id,
          type: "text",
          text: `old turn ${i}`,
        })
        const a = await Session.updateInfo({
          id: Identifier.ascending("message"),
          role: "assistant",
          parentID: u.id,
          sessionID: session.id,
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: model.modelID,
          providerID: model.providerID,
          time: { created: Date.now() },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: a.id,
          sessionID: session.id,
          type: "tool",
          callID: `call-old-${i}`,
          tool: "read",
          state: {
            status: "completed",
            input: {},
            title: "old read",
            metadata: {},
            output: bigOutput,
            time: { start: Date.now(), end: Date.now() },
          },
        })
      }

      // Summary message from the previous compaction (the boundary).
      const lastOldUser = await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID: session.id,
        agent: "build",
        model,
        time: { created: Date.now() },
      })
      const summaryAssistant = await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "assistant",
        parentID: lastOldUser.id,
        sessionID: session.id,
        mode: "compaction",
        agent: "compaction",
        summary: true,
        path: { cwd: tmp.path, root: tmp.path },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: model.modelID,
        providerID: model.providerID,
        time: { created: Date.now(), completed: Date.now() },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: summaryAssistant.id,
        sessionID: session.id,
        type: "text",
        text: "previous summary content",
      })

      // History after the summary: repeated Read calls, as in real sessions.
      for (let i = 0; i < 30; i++) {
        const u = await Session.updateInfo({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model,
          time: { created: Date.now() },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: u.id,
          sessionID: session.id,
          type: "text",
          text: `new turn ${i}`,
        })
        const a = await Session.updateInfo({
          id: Identifier.ascending("message"),
          role: "assistant",
          parentID: u.id,
          sessionID: session.id,
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: model.modelID,
          providerID: model.providerID,
          time: { created: Date.now() },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: a.id,
          sessionID: session.id,
          type: "tool",
          callID: `call-new-${i}`,
          tool: "read",
          state: {
            status: "completed",
            input: {},
            title: "new read",
            metadata: {},
            output: bigOutput,
            time: { start: Date.now(), end: Date.now() },
          },
        })
      }

      // Trigger the second compaction.
      const compactUser = await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID: session.id,
        agent: "build",
        model,
        time: { created: Date.now() },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: compactUser.id,
        sessionID: session.id,
        type: "compaction",
        auto: true,
      })

      const messages = await Session.messages({ sessionID: session.id })
      const start = Date.now()
      const result = await SessionCompaction.process({
        parentID: compactUser.id,
        messages,
        sessionID: session.id,
        abort: new AbortController().signal,
        auto: true,
      })
      const elapsed = Date.now() - start

      expect(result).toBeDefined()
      // Performance sentinel: with 530 turns and 1060 completed tool parts, the budget scan plus compaction should
      // finish within seconds; an O(n^2) pass or blocking I/O would fail here before real sessions slow down.
      //
      // Wall-clock time also depends on machine load: the suite runs test files in parallel (see maxWorkers in
      // vitest.config.ts), where a 5s threshold gives false alarms. CI only checks that a large history completes
      // without errors; the timing threshold is opt-in for local performance checks:
      //   MERAKCODE_PERF_ASSERT=1 vitest run test/session/compaction-large-history.test.ts
      if (process.env.MERAKCODE_PERF_ASSERT) expect(elapsed).toBeLessThan(5000)
      else if (elapsed >= 5000)
        console.warn(`⚠️ compaction took ${elapsed}ms (>=5s); if not caused by machine load, check for a regression`)
    },
  })
  // Most of the time goes into writing the 530-turn fixture (compaction itself is <5s), which is very sensitive to
  // I/O contention: 9.8s idle, ~31s with 4 parallel runs, and over 60s under CI load. The timeout is only a hang
  // sentinel with plenty of headroom; performance is covered by MERAKCODE_PERF_ASSERT above.
}, 180000)
