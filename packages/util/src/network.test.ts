import { describe, expect, test } from "vitest"
import http from "node:http"
import net from "node:net"
import { Network } from "./network"

// Node's fetch (undici) puts the real reason in cause; the shapes below were observed in practice
const socket = (message: string, code: string) => Object.assign(new Error(message), { code })

async function listen(server: net.Server, port = 0) {
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve))
  return (server.address() as net.AddressInfo).port
}

const close = (server: net.Server) => new Promise((resolve) => server.close(resolve))

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
    const port = await listen(closed)
    await close(closed)
    expect(Network.failure(await fetch(`http://127.0.0.1:${port}/`).catch((e) => e))).toBe("unreachable")

    const server = http.createServer((_request, response) => {
      response.write("Hello,")
      setTimeout(() => response.socket?.destroy(), 25)
    })
    const open = await listen(server)
    const dropped = await fetch(`http://127.0.0.1:${open}/`)
      .then((response) => response.text())
      .catch((e) => e)
    await close(server)
    expect(Network.failure(dropped)).toBe("reset")
  })
})

describe("Network.freePort", () => {
  test("returns an unused port that can be listened on right away", async () => {
    const port = await Network.freePort()
    expect(port).toBeGreaterThan(0)
    const server = net.createServer()
    expect(await listen(server, port)).toBe(port)
    await close(server)
  })
})
