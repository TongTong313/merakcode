import { describe, expect, test } from "vitest"
import net from "node:net"
import { Network } from "./network"
import { Http } from "./http"

// Node's fetch (undici) puts the real reason in cause; the shapes below were observed in practice
const socket = (message: string, code: string) => Object.assign(new Error(message), { code })

describe("Network.failure", () => {
  test("a connection dropped midway (terminated by a socket close or ECONNRESET) is reset", () => {
    const undici = new TypeError("terminated", {
      cause: Object.assign(new Error("other side closed"), { name: "SocketError", code: "UND_ERR_SOCKET" }),
    })
    expect(Network.failure(undici)).toBe("reset")
    expect(Network.failure(new TypeError("terminated", { cause: socket("read ECONNRESET", "ECONNRESET") }))).toBe(
      "reset",
    )
  })

  test("fetch failed from refused, DNS or unreachable errors is unreachable", () => {
    for (const code of [
      "ECONNREFUSED",
      "ENOTFOUND",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "EAI_AGAIN",
      "UND_ERR_CONNECT_TIMEOUT",
    ]) {
      expect(Network.failure(new TypeError("fetch failed", { cause: socket(`connect ${code}`, code) }))).toBe(
        "unreachable",
      )
    }
  })

  test("returns undefined for other errors (aborts, plain errors, non-errors)", () => {
    expect(
      Network.failure(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
    ).toBeUndefined()
    expect(Network.failure(new Error("boom"))).toBeUndefined()
    expect(Network.failure(new TypeError("fetch failed", { cause: new Error("bad port") }))).toBeUndefined()
    expect(Network.failure("text")).toBeUndefined()
    expect(Network.failure(undefined)).toBeUndefined()
  })

  test("real network: a closed port is unreachable and a response cut off midway is reset", async () => {
    const closed = net.createServer()
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve))
    const port = (closed.address() as net.AddressInfo).port
    await new Promise((resolve) => closed.close(resolve))
    expect(Network.failure(await fetch(`http://127.0.0.1:${port}/`).catch((e) => e))).toBe("unreachable")

    await using server: Http.Server = await Http.serve({
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("Hello,"))
              setTimeout(() => void server.stop(true), 25)
            },
          }),
        ),
    })
    const dropped = await fetch(server.url)
      .then((response) => response.text())
      .catch((e) => e)
    expect(Network.failure(dropped)).toBe("reset")
  })
})

describe("Network.freePort", () => {
  test("returns an unused port that can be listened on right away", async () => {
    const port = await Network.freePort()
    expect(port).toBeGreaterThan(0)
    await using server = await Http.serve({ port, fetch: () => new Response("ok") })
    expect(server.port).toBe(port)
  })
})
