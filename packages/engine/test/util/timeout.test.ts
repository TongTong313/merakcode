import { describe, expect, test } from "vitest"
import { withFallbackTimeout, withTimeout } from "@merakcode/engine/util/timeout"

describe("util.timeout", () => {
  test("should resolve when promise completes before timeout", async () => {
    const fastPromise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("fast"), 10)
    })

    const result = await withTimeout(fastPromise, 100)
    expect(result).toBe("fast")
  })

  test("should reject when promise exceeds timeout", async () => {
    const slowPromise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("slow"), 200)
    })

    await expect(withTimeout(slowPromise, 50)).rejects.toThrow("Operation timed out after 50ms")
  })
})

// For optional work such as fetching LSP diagnostics after an edit: timeouts and failures fall back instead of throwing
describe("withFallbackTimeout", () => {
  test("returns the work result when it resolves in time", async () => {
    const work = new Promise<string>((resolve) => {
      setTimeout(() => resolve("ok"), 10)
    })
    const result = await withFallbackTimeout(work, 100, () => "fallback")
    expect(result).toBe("ok")
  })

  test("returns fallback() on timeout", async () => {
    const work = new Promise<string>(() => {
      /* never resolves */
    })
    const result = await withFallbackTimeout(work, 30, () => "fallback")
    expect(result).toBe("fallback")
  })

  test("returns fallback() without throwing when work rejects", async () => {
    const work = Promise.reject(new Error("boom"))
    const result = await withFallbackTimeout(work, 100, () => "fallback")
    expect(result).toBe("fallback")
  })
})
