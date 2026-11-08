import { describe, expect, test } from "vitest"
import { Auth } from "../src/auth"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const origin = "http://127.0.0.1:4100"
const request = (patch: Partial<Auth.Request>): Auth.Request => ({
  url: `${origin}/session`,
  resourceType: "xhr",
  subframe: false,
  ...patch,
})

test("serves built assets and application routes without escaping the UI directory", () => {
  const root = mkdtempSync(path.join(tmpdir(), "merak-ui-"))
  try {
    mkdirSync(path.join(root, "assets"))
    writeFileSync(path.join(root, "index.html"), "<main>MerakCode</main>")
    writeFileSync(path.join(root, "assets", "app.js"), "export {}")
    expect(Auth.asset(root, "/project/session")).toBe(path.join(root, "index.html"))
    expect(Auth.asset(root, "/assets/app.js")).toBe(path.join(root, "assets", "app.js"))
    expect(Auth.asset(root, "/assets/missing.js")).toBeUndefined()
    expect(Auth.asset(root, "/%2e%2e/secret")).toBeUndefined()
    expect(Auth.asset(root, "/%5c%5cserver/share")).toBeUndefined()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
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
