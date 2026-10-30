import { describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"
import { abortAfter, abortAfterAny } from "./abort"
import { setTimeout as delay } from "node:timers/promises"

/**
 * Forces a full GC. On Node, --expose-gc is enabled on the fly to get gc(); Bun has neither globalThis.gc nor
 * v8.setFlagsFromString, so its own synchronous full collection is used.
 */
function collect() {
  const bun = (globalThis as { Bun?: { gc(force: boolean): void } }).Bun
  if (bun) return bun.gc(true)
  setFlagsFromString("--expose-gc")
  ;(runInNewContext("gc") as () => void)()
}

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

describe("timers must not retain the caller's scope", () => {
  /**
   * Observes reachability directly with WeakRef instead of measuring heap growth: process.memoryUsage().heapUsed
   * noise reaches ±10MB, more than the signal (50 × 50KB = 2.5MB), and drifts with other files and machine load.
   * Reachability is binary: an object captured by a closure stays alive, one passed through bind is collected.
   *
   * This is the only guard for this contract. Observing a webfetch result through the Tool wrapper does not work: the
   * wrapper copies it into a new object, so a timer leak inside webfetch goes unnoticed.
   */

  test("abortAfter does not retain a large object in the caller's scope", async () => {
    let body: { text: string } | null = { text: "x".repeat(200_000) }
    const ref = new WeakRef(body)
    const { clearTimeout: clear } = abortAfter(30_000)
    body = null
    // The spec keeps a WeakRef target alive until the job that created it ends, so wait one macrotask before GC
    await delay(0)
    collect()
    expect(ref.deref()).toBeUndefined()
    clear()
  })

  test("control: the same measurement sees the object alive when a handler closure captures it", async () => {
    let body: { text: string } | null = { text: "x".repeat(200_000) }
    const ref = new WeakRef(body)
    const held = body // The pattern to avoid: the timer handler closure captures body
    const timer = setTimeout(() => void held.text.length, 30_000)
    body = null
    await delay(0)
    collect()
    expect(ref.deref()).toBeDefined()
    clearTimeout(timer)
  })

  test("the timer handler uses bind, not an arrow closure that captures scope", () => {
    // A convention guard rather than a behavior test: an arrow closure inside abortAfter only captures its own scope
    // and cannot be observed from outside, but moved to a call site it would retain the response body until the
    // timeout. The convention is documented in abort.ts and pinned here so it does not regress silently.
    const src = readFileSync(join(import.meta.dirname, "abort.ts"), "utf8")
    expect(src).toContain("setTimeout(controller.abort.bind(controller)")
    expect(src).not.toMatch(/setTimeout\(\s*\(\s*\)\s*=>/)
  })
})
