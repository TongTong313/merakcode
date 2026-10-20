import { describe, expect, test } from "vitest"
import { pickClientsForEditDiagnostics } from "./edit-clients"

describe("pickClientsForEditDiagnostics", () => {
  test("returns ready clients immediately without waiting for pending", async () => {
    let pendingResolved = false
    const pending = new Promise<string[]>((resolve) => {
      setTimeout(() => {
        pendingResolved = true
        resolve(["late"])
      }, 200)
    })
    const started = Date.now()
    const result = await pickClientsForEditDiagnostics({
      ready: ["ready-a", "ready-b"],
      pending,
      readyTimeoutMs: 50,
      peekReady: () => ["peek"],
    })
    expect(result).toEqual(["ready-a", "ready-b"])
    expect(Date.now() - started).toBeLessThan(100)
    expect(pendingResolved).toBe(false)
  })

  test("returns the pending result when nothing is ready and pending finishes in time", async () => {
    const pending = new Promise<string[]>((resolve) => {
      setTimeout(() => resolve(["slow-ok"]), 20)
    })
    const result = await pickClientsForEditDiagnostics({
      ready: [],
      pending,
      readyTimeoutMs: 100,
      peekReady: () => ["peek"],
    })
    expect(result).toEqual(["slow-ok"])
  })

  test("returns the peekReady snapshot without throwing when nothing is ready and pending times out", async () => {
    const pending = new Promise<string[]>(() => {
      /* never resolves */
    })
    const result = await pickClientsForEditDiagnostics({
      ready: [],
      pending,
      readyTimeoutMs: 30,
      peekReady: () => ["peek-after-timeout"],
    })
    expect(result).toEqual(["peek-after-timeout"])
  })

  test("returns peekReady without throwing when nothing is ready and pending rejects", async () => {
    const pending = Promise.reject(new Error("lsp broken"))
    const result = await pickClientsForEditDiagnostics({
      ready: [],
      pending,
      readyTimeoutMs: 100,
      peekReady: () => [],
    })
    expect(result).toEqual([])
  })
})
