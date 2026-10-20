import { describe, expect, test } from "vitest"
import { Http } from "./http"

describe("Http.serve", () => {
  test("serves a fetch-style handler; port 0 lets the OS pick and url points to the real port", async () => {
    await using server = await Http.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => Response.json({ path: new URL(request.url).pathname, method: request.method }),
    })
    expect(server.port).toBeGreaterThan(0)
    expect(server.url.href).toBe(`http://127.0.0.1:${server.port}/`)
    expect(await (await fetch(new URL("/a/b", server.url), { method: "POST" })).json()).toEqual({
      path: "/a/b",
      method: "POST",
    })
  })

  test("supports request bodies and streaming responses", async () => {
    await using server = await Http.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const body = await request.text()
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`got:${body}`))
            controller.close()
          },
        })
        return new Response(stream)
      },
    })
    expect(await (await fetch(server.url, { method: "POST", body: "hello" })).text()).toBe("got:hello")
  })

  test("uses error when the handler throws, or returns 500 without it", async () => {
    await using withHandler = await Http.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        throw new Error("boom")
      },
      error: (error) => new Response(`handled ${error.message}`, { status: 418 }),
    })
    const handled = await fetch(withHandler.url)
    expect([handled.status, await handled.text()]).toEqual([418, "handled boom"])

    await using without = await Http.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Promise.reject(new Error("x")),
    })
    expect((await fetch(without.url)).status).toBe(500)
  })

  test("rejects with EADDRINUSE when the port is taken", async () => {
    await using first = await Http.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
    await expect(
      Http.serve({ hostname: "127.0.0.1", port: first.port, fetch: () => new Response("") }),
    ).rejects.toMatchObject({
      code: "EADDRINUSE",
    })
  })

  test("stop(true) drops pending requests at once and refuses new connections", async () => {
    const server = await Http.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise<Response>(() => {}) })
    const pending = fetch(server.url).then(
      () => "answered",
      () => "dropped",
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    await server.stop(true)
    expect(await pending).toBe("dropped")
    expect(
      await fetch(server.url).then(
        () => "open",
        () => "closed",
      ),
    ).toBe("closed")
  })

  // Streaming responses (SSE, model streams) rely on this to stop in time; Bun's node:http does not emit res close
  test("aborts request.signal and cancels the response stream when the client disconnects", async () => {
    let cancelled = false
    let aborted = false
    await using server = await Http.serve({
      fetch: (request) => {
        request.signal.addEventListener("abort", () => (aborted = true))
        return new Response(
          new ReadableStream({
            start: (controller) => controller.enqueue(new TextEncoder().encode("data: x\n\n")),
            cancel: () => void (cancelled = true),
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const abort = new AbortController()
    const response = await fetch(server.url, { signal: abort.signal })
    await response.body!.getReader().read()
    abort.abort()
    for (let i = 0; i < 50 && !(cancelled && aborted); i++) await new Promise((resolve) => setTimeout(resolve, 20))
    expect({ cancelled, aborted }).toEqual({ cancelled: true, aborted: true })
  })

  // req emits close as soon as the body is read, while the client is still connected; that is not a disconnect
  test("keeps a streaming response alive after a POST body is read until the client disconnects", async () => {
    let cancelled = false
    await using server = await Http.serve({
      fetch: async (request) => {
        await request.json()
        return new Response(
          new ReadableStream({
            start: (controller) => controller.enqueue(new TextEncoder().encode("data: x\n\n")),
            cancel: () => void (cancelled = true),
          }),
        )
      },
    })
    const abort = new AbortController()
    const response = await fetch(server.url, { method: "POST", body: JSON.stringify({ a: 1 }), signal: abort.signal })
    await response.body!.getReader().read()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(cancelled).toBe(false)
    abort.abort()
    for (let i = 0; i < 50 && !cancelled; i++) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(cancelled).toBe(true)
  })

  test("stop(true) still stops promptly after a client drops a streaming response", async () => {
    const server = await Http.serve({
      fetch: () =>
        new Response(
          new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode("data: x\n\n")) }),
        ),
    })
    const abort = new AbortController()
    const response = await fetch(server.url, { signal: abort.signal })
    await response.body!.getReader().read()
    abort.abort()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const stopped = await Promise.race([
      server.stop(true).then(() => "stopped"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 2_000)),
    ])
    expect(stopped).toBe("stopped")
  })
})
