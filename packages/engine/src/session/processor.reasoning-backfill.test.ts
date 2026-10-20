import { describe, expect, test } from "vitest"
import { needsReasoningEndBackfill } from "./processor"
import type { Message } from "./message"

// At the end of a turn, reasoning parts without time.end get one (the provider sent no reasoning-end because the
// reasoning was aborted, failed, or the stream was not flushed). Otherwise the UI falls back to Date.now() for the
// thinking duration, which keeps growing on every render.
const reasoning = (time: { start: number; end?: number }): Message.Part =>
  ({ id: "r1", sessionID: "s", messageID: "m", type: "reasoning", text: "思考…", time }) as Message.Part

describe("needsReasoningEndBackfill", () => {
  test("matches reasoning without time.end", () => {
    expect(needsReasoningEndBackfill(reasoning({ start: 1_000 }))).toBe(true)
  })

  test("does not match reasoning that already has time.end", () => {
    expect(needsReasoningEndBackfill(reasoning({ start: 1_000, end: 4_200 }))).toBe(false)
  })

  test("never matches non-reasoning parts (tool, text, step-start)", () => {
    const tool = {
      id: "t1",
      sessionID: "s",
      messageID: "m",
      type: "tool",
      callID: "c1",
      tool: "read",
      state: { status: "running", input: {}, time: { start: 1 } },
    } as Message.Part
    const text = {
      id: "x1",
      sessionID: "s",
      messageID: "m",
      type: "text",
      text: "答案",
      time: { start: 1 },
    } as Message.Part
    const stepStart = { id: "ss", sessionID: "s", messageID: "m", type: "step-start" } as Message.Part
    expect(needsReasoningEndBackfill(tool)).toBe(false)
    expect(needsReasoningEndBackfill(text)).toBe(false)
    expect(needsReasoningEndBackfill(stepStart)).toBe(false)
  })

  test("a backfilled end keeps the duration bounded", () => {
    const start = Date.now() - 3_000
    const part = reasoning({ start }) as Message.ReasoningPart
    expect(needsReasoningEndBackfill(part)).toBe(true)
    // Same as the end-of-turn backfill: end = Date.now()
    const patched: Message.ReasoningPart = { ...part, time: { ...part.time, end: Date.now() } }
    const sec = Math.round((patched.time.end! - patched.time.start) / 1000)
    expect(sec).toBeGreaterThanOrEqual(2)
    expect(sec).toBeLessThan(60)
    expect(needsReasoningEndBackfill(patched)).toBe(false)
  })
})
