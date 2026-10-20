import { describe, expect, test } from "vitest"
import { Auth } from "../src/auth"

const origin = "http://127.0.0.1:4100"
const request = (patch: Partial<Auth.Request>): Auth.Request => ({
  url: `${origin}/session`,
  resourceType: "xhr",
  subframe: false,
  ...patch,
})

describe("token on local backend requests", () => {
  test("adds it to backend requests from the app main frame, including page loads and WebSockets", () => {
    expect(Auth.applies(request({ initiatorOrigin: origin }), origin)).toBe(true)
    expect(Auth.applies(request({ resourceType: "mainFrame" }), origin)).toBe(true)
    expect(Auth.applies(request({ url: "ws://127.0.0.1:4100/pty/1/connect", resourceType: "webSocket" }), origin)).toBe(
      true,
    )
  })

  test("skips subframes, other initiators and other destinations", () => {
    expect(Auth.applies(request({ subframe: true, initiatorOrigin: origin }), origin)).toBe(false)
    expect(Auth.applies(request({ resourceType: "subFrame" }), origin)).toBe(false)
    expect(Auth.applies(request({ initiatorOrigin: "http://localhost:3000" }), origin)).toBe(false)
    expect(Auth.applies(request({ url: "http://127.0.0.1:4101/session" }), origin)).toBe(false)
    expect(Auth.applies(request({ url: "https://example.com/" }), origin)).toBe(false)
  })
})
