import { describe, expect, test } from "vitest"
import { needsReasoningEndBackfill } from "../loop/processor"
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
})
