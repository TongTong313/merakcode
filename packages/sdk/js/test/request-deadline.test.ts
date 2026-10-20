import { describe, expect, test } from "vitest"
import { RequestTimeoutError, withRequestDeadline } from "../src/client/request-deadline.js"
import { MerakCodeError } from "../src/errors.js"

describe("request deadline", () => {
  test("returns the transport result", async () => {
    expect(await withRequestDeadline(async () => "ok")).toBe("ok")
  })

  test("bounds requests even when the transport ignores its signal", async () => {
    const pending = withRequestDeadline(async () => new Promise(() => {}), { timeout: 5 })

    await expect(pending).rejects.toBeInstanceOf(RequestTimeoutError)
    await expect(pending).rejects.toBeInstanceOf(MerakCodeError)
    await expect(pending).rejects.toMatchObject({ code: "MRK-1007", retryable: true })
    await expect(pending).rejects.toThrow("The engine did not answer in time")
  })

  test("combines caller cancellation with the deadline signal", async () => {
    let request: AbortSignal | undefined
    const controller = new AbortController()
    const pending = withRequestDeadline(
      async (signal) => {
        request = signal
        return new Promise(() => {})
      },
      { signal: controller.signal },
    )
    const reason = new DOMException("cancelled", "AbortError")

    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
    expect(request?.aborted).toBe(true)
  })

  test("does not start transport for an already cancelled request", async () => {
    let calls = 0
    const controller = new AbortController()
    controller.abort()

    const pending = withRequestDeadline(
      async () => {
        calls++
        return "unexpected"
      },
      { signal: controller.signal },
    )

    await expect(pending).rejects.toBe(controller.signal.reason)
    expect(calls).toBe(0)
  })

  test("does not reinterpret transport failures", async () => {
    const cause = new Error("broken")

    await expect(withRequestDeadline(async () => Promise.reject(cause))).rejects.toBe(cause)
  })
})
