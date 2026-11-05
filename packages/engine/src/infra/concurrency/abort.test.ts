import { describe, expect, test } from "vitest"
import { abortAfter, abortAfterAny } from "./abort"
import { setTimeout as delay } from "node:timers/promises"

describe("abortAfter", () => {
  test("aborts when the timeout elapses", async () => {
    const { signal, clearTimeout: clear } = abortAfter(20)
    expect(signal.aborted).toBe(false)
    await delay(80)
    expect(signal.aborted).toBe(true)
    clear()
  })

  test("does not abort after clearTimeout", async () => {
    const { signal, clearTimeout: clear } = abortAfter(20)
    clear()
    await delay(80)
    expect(signal.aborted).toBe(false)
  })
})

describe("abortAfterAny", () => {
  test("aborts as soon as any input signal aborts, without waiting for the timeout", () => {
    const outer = new AbortController()
    const { signal, clearTimeout: clear } = abortAfterAny(30_000, outer.signal)
    expect(signal.aborted).toBe(false)
    outer.abort()
    expect(signal.aborted).toBe(true)
    clear()
  })

  test("also aborts on timeout", async () => {
    const outer = new AbortController()
    const { signal, clearTimeout: clear } = abortAfterAny(20, outer.signal)
    await delay(80)
    expect(signal.aborted).toBe(true)
    clear()
  })
})
