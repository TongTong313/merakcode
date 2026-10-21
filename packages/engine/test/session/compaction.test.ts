import { describe, expect, test } from "vitest"
import path from "path"
import { SessionCompaction } from "@merakcode/engine/session/compaction"
import { Token } from "@merakcode/engine/util/token"
import { Instance } from "@merakcode/engine/project/instance"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"
import { Session } from "@merakcode/engine/session/index"
import { Message } from "@merakcode/engine/session/message"
import type { Provider } from "@merakcode/engine/provider/provider"
import { Filesystem } from "@merakcode/util/filesystem"

Log.init({ print: false })

test("failed compaction with a finish marker does not discard earlier messages", async () => {
  const user = (id: string, parts: Message.Part[] = []): Message.FullMsg => ({
    info: {
      id,
      sessionID: "session",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "test", modelID: "test" },
    },
    parts,
  })
  const old = user("old")
  const boundary = user("compact", [
    { id: "part", messageID: "compact", sessionID: "session", type: "compaction", auto: false },
  ])
  const failed = {
    info: {
      id: "summary",
      sessionID: "session",
      role: "assistant" as const,
      time: { created: 1 },
      parentID: "compact",
      modelID: "test",
      providerID: "test",
      mode: "compaction",
      agent: "compaction",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      summary: true,
      finish: "stop",
      error: new Message.AbortedError({ message: "post-finish failure" }).toObject(),
    },
    parts: [],
  } satisfies Message.FullMsg
  const latest = user("latest")
  async function* stream(summary: Message.FullMsg) {
    yield latest
    yield summary
    yield boundary
    yield old
  }
  expect((await Message.filterCompacted(stream(failed))).map((item) => item.info.id)).toEqual([
    "old",
    "compact",
    "summary",
    "latest",
  ])
  const completed = { ...failed, info: { ...failed.info, error: undefined } } satisfies Message.FullMsg
  expect((await Message.filterCompacted(stream(completed))).map((item) => item.info.id)).toEqual([
    "compact",
    "summary",
    "latest",
  ])
})

function createModel(opts: {
  context: number
  output: number
  input?: number
  cost?: Provider.Model["cost"]
  npm?: string
}): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: {
      context: opts.context,
      input: opts.input,
      output: opts.output,
    },
    cost: opts.cost ?? { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: opts.npm ?? "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

test("compaction create stores the permissionMode that the auto-continuation inherits", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})

      await SessionCompaction.create({
        sessionID: session.id,
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-4" },
        permissionMode: "auto",
        auto: true,
      })

      const messages = await Session.messages({ sessionID: session.id })
      const user = messages.find((msg) => msg.parts.some((part) => part.type === "compaction"))
      if (user?.info.role !== "user") throw new Error("expected compaction user message")
      const part = user.parts.find((p): p is Message.CompactionPart => p.type === "compaction")

      expect(user.info.permissionMode).toBeUndefined()
      expect(part?.permissionMode).toBe("auto")
    },
  })
})

describe("session.compaction.isOverflow", () => {
  test("returns true when token count exceeds usable context", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 100_000, output: 32_000 })
        const tokens = { input: 75_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(true)
      },
    })
  })

  test("returns false when token count within usable context", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 200_000, output: 32_000 })
        const tokens = { input: 100_000, output: 10_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(false)
      },
    })
  })

  test("includes cache.read in token count", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 100_000, output: 32_000 })
        const tokens = { input: 60_000, output: 10_000, reasoning: 0, cache: { read: 10_000, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(true)
      },
    })
  })

  test("respects input limit for input caps", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 400_000, input: 272_000, output: 128_000 })
        const tokens = { input: 271_000, output: 1_000, reasoning: 0, cache: { read: 2_000, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(true)
      },
    })
  })

  test("returns false when input/output are within input caps", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 400_000, input: 272_000, output: 128_000 })
        const tokens = { input: 200_000, output: 20_000, reasoning: 0, cache: { read: 10_000, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(false)
      },
    })
  })

  test("returns false when output within limit with input caps", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 200_000, input: 120_000, output: 10_000 })
        const tokens = { input: 50_000, output: 9_999, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(false)
      },
    })
  })

  // ─── Bug reproduction tests ───────────────────────────────────────────
  // These tests demonstrate that when limit.input is set, isOverflow()
  // does not subtract any headroom for the next model response. This means
  // compaction only triggers AFTER we've already consumed the full input
  // budget, leaving zero room for the next API call's output tokens.
  //
  // Compare: without limit.input, usable = context - output (reserves space).
  // With limit.input, usable = limit.input (reserves nothing).
  //
  // Related issues: #10634, #8089, #11086, #12621
  // Open PRs: #6875, #12924

  test("BUG: no headroom when limit.input is set — compaction should trigger near boundary but does not", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Simulate Claude with prompt caching: input limit = 200K, output limit = 32K
        const model = createModel({ context: 200_000, input: 200_000, output: 32_000 })

        // We've used 198K tokens total. Only 2K under the input limit.
        // On the next turn, the full conversation (198K) becomes input,
        // plus the model needs room to generate output — this WILL overflow.
        const tokens = { input: 180_000, output: 15_000, reasoning: 0, cache: { read: 3_000, write: 0 } }
        // count = 180K + 3K + 15K = 198K
        // usable = limit.input = 200K (no output subtracted!)
        // 198K > 200K = false → no compaction triggered

        // WITHOUT limit.input: usable = 200K - 32K = 168K, and 198K > 168K = true ✓
        // WITH limit.input: usable = 200K, and 198K > 200K = false ✗

        // With 198K used and only 2K headroom, the next turn will overflow.
        // Compaction MUST trigger here.
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(true)
      },
    })
  })

  test("BUG: without limit.input, same token count correctly triggers compaction", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Same model but without limit.input — uses context - output instead
        const model = createModel({ context: 200_000, output: 32_000 })

        // Same token usage as above
        const tokens = { input: 180_000, output: 15_000, reasoning: 0, cache: { read: 3_000, write: 0 } }
        // count = 198K
        // usable = context - output = 200K - 32K = 168K
        // 198K > 168K = true → compaction correctly triggered

        const result = await SessionCompaction.isOverflow({ tokens, model })
        expect(result).toBe(true) // ← Correct: headroom is reserved
      },
    })
  })

  test("BUG: asymmetry — limit.input model allows 30K more usage before compaction than equivalent model without it", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Two models with identical context/output limits, differing only in limit.input
        const withInputLimit = createModel({ context: 200_000, input: 200_000, output: 32_000 })
        const withoutInputLimit = createModel({ context: 200_000, output: 32_000 })

        // 170K total tokens — well above context-output (168K) but below input limit (200K)
        const tokens = { input: 166_000, output: 10_000, reasoning: 0, cache: { read: 5_000, write: 0 } }

        const withLimit = await SessionCompaction.isOverflow({ tokens, model: withInputLimit })
        const withoutLimit = await SessionCompaction.isOverflow({ tokens, model: withoutInputLimit })

        // Both models have identical real capacity — they should agree:
        expect(withLimit).toBe(true) // should compact (170K leaves no room for 32K output)
        expect(withoutLimit).toBe(true) // correctly compacts (170K > 168K)
      },
    })
  })

  test("returns false when model context limit is 0", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 0, output: 32_000 })
        const tokens = { input: 100_000, output: 10_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(false)
      },
    })
  })

  test("returns false when compaction.auto is disabled", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(
          path.join(dir, "merakcode.json"),
          JSON.stringify({
            compaction: { auto: false },
          }),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 100_000, output: 32_000 })
        const tokens = { input: 75_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(false)
      },
    })
  })

  test("compacts a million-token window once the previous turn is within 6_000 of the real output limit", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 1_000_000, output: 128_000 })
        const below = { input: 865_999, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        const at = { input: 866_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens: below, model })).toBe(false)
        expect(await SessionCompaction.isOverflow({ tokens: at, model })).toBe(true)
      },
    })
  })

  test("keeps room to talk when the output limit fills the window", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 262_144, output: 262_144 })
        const comfortable = { input: 200_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        const at = { input: 224_144, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens: comfortable, model })).toBe(false)
        expect(await SessionCompaction.isOverflow({ tokens: at, model })).toBe(true)
      },
    })
  })
})

describe("util.token.estimate", () => {
  test("estimates tokens from text (4 chars per token)", () => {
    const text = "x".repeat(4000)
    expect(Token.estimate(text)).toBe(1000)
  })

  test("estimates tokens from larger text", () => {
    const text = "y".repeat(20_000)
    expect(Token.estimate(text)).toBe(5000)
  })

  test("returns 0 for empty string", () => {
    expect(Token.estimate("")).toBe(0)
  })

  test("estimates CJK text closer to one token per character", () => {
    expect(Token.estimate("\u4f60\u597d\u4e16\u754c")).toBe(4)
  })

  test("estimates structured messages", () => {
    const result = Token.estimateMessages([
      {
        role: "user",
        content: "hello",
      },
    ])

    expect(result).toBeGreaterThan(Token.estimate("hello"))
  })

  test("handles circular arrays in structured estimates", () => {
    const value: unknown[] = []
    value.push(value)

    expect(Token.estimateValue(value)).toBeGreaterThanOrEqual(0)
  })
})

describe("session.getUsage", () => {
  // AI SDK normalized usage: inputTokens is the total input including cache reads and writes, broken down in
  // inputTokenDetails.
  const usage = (input: {
    total?: number
    noCache?: number
    cacheRead?: number
    cacheWrite?: number
    output?: number
    reasoning?: number
    totalTokens?: number
  }) => ({
    inputTokens: input.total,
    inputTokenDetails: {
      noCacheTokens: input.noCache,
      cacheReadTokens: input.cacheRead,
      cacheWriteTokens: input.cacheWrite,
    },
    outputTokens: input.output,
    outputTokenDetails: { textTokens: undefined, reasoningTokens: input.reasoning },
    totalTokens: input.totalTokens,
  })

  test("counts all input as input when there is no cache", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({ model, usage: usage({ total: 1000, output: 500, totalTokens: 1500 }) })

    expect(result.tokens).toEqual({ total: 1500, input: 1000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } })
  })

  test("splits cache reads and writes out of the total input", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: usage({ total: 1500, noCache: 1000, cacheRead: 200, cacheWrite: 300, output: 500, totalTokens: 2000 }),
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.cache).toEqual({ read: 200, write: 300 })
    expect(result.tokens.total).toBe(2000)
  })

  test("derives uncached input by subtracting cache reads and writes when the provider omits it", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({ model, usage: usage({ total: 1000, cacheRead: 200, output: 500 }) })

    expect(result.tokens.input).toBe(800)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("sums input and output when the total is missing", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({ model, usage: usage({ total: 1200, cacheRead: 200, output: 300 }) })

    expect(result.tokens.total).toBe(1500)
  })

  test("takes reasoning tokens from the output details", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({ model, usage: usage({ total: 1000, output: 500, reasoning: 100 }) })

    expect(result.tokens.reasoning).toBe(100)
  })

  test("returns zeros and a non-NaN cost when every field is missing", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({ model, usage: usage({}) })

    expect(result.tokens).toEqual({ total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
    expect(Number.isNaN(result.cost)).toBe(false)
  })

  test("prices input, output, cache reads and cache writes separately", () => {
    const model = createModel({
      context: 100_000,
      output: 32_000,
      cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
    })
    const result = Session.getUsage({
      model,
      usage: usage({
        total: 1_400_000,
        noCache: 1_000_000,
        cacheRead: 200_000,
        cacheWrite: 200_000,
        output: 100_000,
      }),
    })

    expect(result.cost).toBeCloseTo(3 + 1.5 + 0.06 + 0.75)
  })

  // Normalized output tokens already include reasoning tokens, so reasoning must not be charged again.
  test("does not charge reasoning tokens twice", () => {
    const model = createModel({
      context: 100_000,
      output: 32_000,
      cost: { input: 0, output: 10, cache: { read: 0, write: 0 } },
    })
    const result = Session.getUsage({ model, usage: usage({ total: 0, output: 1_000_000, reasoning: 400_000 }) })

    expect(result.cost).toBe(10)
  })
})
