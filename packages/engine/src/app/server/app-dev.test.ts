import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { AppDev } from "./app-dev"
import { APP_CSP } from "./app-security"

describe("AppDev.url", () => {
  test("accepts only plain HTTP on a loopback address", () => {
    for (const value of ["http://127.0.0.1:5173", "http://localhost:5173/", "http://[::1]:5173"])
      expect(AppDev.url(value)?.protocol, value).toBe("http:")
    for (const value of ["", "https://127.0.0.1:5173", "http://192.168.1.2:5173", "http://example.com", "not a url"])
      expect(AppDev.url(value), value).toBeUndefined()
    expect(AppDev.url(undefined)).toBeUndefined()
  })
})

describe("AppDev.forward", () => {
  const seen: IncomingMessage[] = []
  const vite = createServer((request, response) => {
    seen.push(request)
    if (request.url === "/src/entry.tsx" && request.headers["if-none-match"] === '"v1"') {
      response.writeHead(304, { etag: '"v1"' }).end()
      return
    }
    if (request.url?.startsWith("/src/")) {
      response.writeHead(200, { "content-type": "text/javascript", etag: '"v1"' }).end("export {}")
      return
    }
    response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>dev</title>")
  })
  let base: URL

  beforeAll(async () => {
    await new Promise<void>((resolve) => vite.listen(0, "127.0.0.1", resolve))
    base = new URL(`http://127.0.0.1:${(vite.address() as AddressInfo).port}`)
  })
  afterAll(() => new Promise<void>((resolve) => vite.close(() => resolve())))

  test("pages keep the path and query, get the app's security headers, and the backend token stays behind", async () => {
    const response = await AppDev.forward(
      new Request("http://127.0.0.1:4096/abc/session/ses_1?x=1", {
        headers: { accept: "text/html", authorization: "Basic secret", cookie: "a=b" },
      }),
      base,
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("<title>dev</title>")
    expect(response.headers.get("content-security-policy")).toBe(APP_CSP)
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    const request = seen.at(-1)!
    expect(request.url).toBe("/abc/session/ses_1?x=1")
    expect(request.headers.accept).toBe("text/html")
    expect(request.headers.authorization).toBeUndefined()
    expect(request.headers.cookie).toBeUndefined()
  })

  test("modules keep their type and cache validators, and unchanged ones come back as 304", async () => {
    const first = await AppDev.forward(new Request("http://127.0.0.1:4096/src/entry.tsx"), base)
    expect(first.headers.get("content-type")).toBe("text/javascript")
    expect(first.headers.get("content-security-policy")).toBeNull()
    expect(first.headers.get("etag")).toBe('"v1"')
    expect(await first.text()).toBe("export {}")

    const again = await AppDev.forward(
      new Request("http://127.0.0.1:4096/src/entry.tsx", { headers: { "if-none-match": '"v1"' } }),
      base,
    )
    expect(again.status).toBe(304)
    expect(again.headers.get("etag")).toBe('"v1"')
  })
})
