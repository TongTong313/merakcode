import { describe, expect, test } from "vitest"
import { APP_CSP, appAssetHeaders, isFrontendStaticAssetPath, resolveAssetContentType } from "./app-security"

describe("app static security headers", () => {
  test("main app has an enforcing CSP and cannot be framed", () => {
    const headers = appAssetHeaders("text/html; charset=utf-8")
    expect(headers["content-security-policy"]).toBe(APP_CSP)
    expect(headers["content-security-policy"]).toContain("default-src 'self'")
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'")
  })

  test("the app embeds no frames and only talks to its own backend", () => {
    // The browser panel is a native view in the main process, not an iframe; the UI only connects to the local
    // backend (HTTP and the terminal WebSocket).
    expect(APP_CSP).toContain("frame-src 'none'")
    expect(APP_CSP).toContain("connect-src 'self' ws: wss:")
    expect(APP_CSP).not.toMatch(/connect-src[^;]*\bhttps?:/)
  })

  test("every HTML page gets the main app policy: cannot be framed, no eval", () => {
    const csp = appAssetHeaders("text/html")["content-security-policy"]
    expect(csp).toBe(APP_CSP)
    expect(csp).not.toContain("'unsafe-eval'")
  })

  test("all static assets get MIME sniffing and referrer protection", () => {
    expect(appAssetHeaders("application/javascript")).toEqual({
      "content-type": "application/javascript",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    })
  })

  test("frontend static assets include wasm and hashed /assets paths", () => {
    expect(isFrontendStaticAssetPath("/assets/ghostty-web-DLDvDQ3l.wasm")).toBe(true)
    expect(isFrontendStaticAssetPath("ghostty_bg.wasm")).toBe(true)
    expect(isFrontendStaticAssetPath("/ghostty-vt.wasm")).toBe(true)
    expect(isFrontendStaticAssetPath("/pty/term-1/connect")).toBe(false)
    expect(isFrontendStaticAssetPath("/session/ses_1")).toBe(false)
  })

  test("wasm is served as application/wasm under nosniff", () => {
    expect(resolveAssetContentType("/assets/ghostty.wasm", "application/octet-stream")).toBe("application/wasm")
    expect(resolveAssetContentType("assets/app.js", "application/javascript")).toBe("application/javascript")
  })
})
