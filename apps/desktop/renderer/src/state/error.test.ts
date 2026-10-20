import { describe, expect, test } from "vitest"
import { MerakCodeError } from "@merakcode/sdk/errors"
import { details, summary } from "./error"

describe("error summary", () => {
  test("shows the code and request id of an engine error", () => {
    const error = new MerakCodeError({ code: "MRK-1011", message: "session not found", requestID: "req_1" })
    expect(summary(error)).toBe("MRK-1011 · req_1")
  })

  test("a session error has a code but no request id", () => {
    expect(summary({ name: "APIError", code: "MRK-2006", data: { message: "bad gateway" } })).toBe("MRK-2006")
  })

  test("errors without a code have no summary", () => {
    expect(summary(new Error("plain"))).toBeUndefined()
    expect(summary(undefined)).toBeUndefined()
  })
})

describe("error details for bug reports", () => {
  test("lists code, message, request id, status, version and platform, one per line", () => {
    const error = new MerakCodeError({
      code: "MRK-1011",
      message: "session not found",
      requestID: "req_1",
      status: 404,
    })
    const text = details(error, { version: "1.2.3", platform: "win32", time: "2026-10-20T00:00:00.000Z" })
    expect(text.split("\n")).toEqual([
      "code: MRK-1011",
      "message: session not found",
      "request: req_1",
      "status: 404",
      "version: 1.2.3",
      "platform: win32",
      "time: 2026-10-20T00:00:00.000Z",
    ])
  })

  test("a session error uses its data message and skips missing fields", () => {
    const text = details(
      { name: "APIError", code: "MRK-2006", data: { message: "bad gateway" } },
      { version: "1.2.3", platform: "linux", time: "t" },
    )
    expect(text).toBe("code: MRK-2006\nmessage: bad gateway\nversion: 1.2.3\nplatform: linux\ntime: t")
  })
})
