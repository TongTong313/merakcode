// @vitest-environment node
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import type { Duplex } from "node:stream"
import { expect, test, vi } from "vitest"
import { createPanels } from "../panel/state"
import { promoteTerminal, sendTerminalInput, stopAllTerminals, terminalFor } from "./resource"

vi.hoisted(async () => {
  const { Window } = await import("happy-dom")
  const window = new Window()
  vi.stubGlobal("window", window)
  vi.stubGlobal("document", window.document)
  vi.stubGlobal("navigator", window.navigator)
  vi.stubGlobal("localStorage", window.localStorage)
})

test("temporary lookup and owner update failures preserve the terminal for retry", async () => {
  let lookups = 0
  let updates = 0
  let closes = 0
  let ownerSessionID = "first"
  const owner = await createPanels("terminal-retry", { get: async () => null, set: async () => {} })
  const id = owner.open({ kind: "terminal", ptyID: "pty_retry" })
  const tab = owner.state.tabs[0]!
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json")
    if (request.url?.includes("close-owned") || request.method === "DELETE") {
      closes++
      response.end("true")
      return
    }
    if (request.method === "GET" && ++lookups === 1) {
      response.writeHead(503)
      response.end("{}")
      return
    }
    if (request.method === "PUT") {
      if (++updates === 1) {
        response.writeHead(503)
        response.end("{}")
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk)
      ownerSessionID = JSON.parse(Buffer.concat(chunks).toString()).owner?.sessionID ?? ownerSessionID
    }
    response.end(
      JSON.stringify({ id: "pty_retry", status: "running", owner: { tabID: id, sessionID: ownerSessionID } }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  vi.stubGlobal("location", { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` })
  try {
    await expect(terminalFor(tab, "/terminal-retry", owner, "first")).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(closes).toBe(0)
    expect(await terminalFor(tab, "/terminal-retry", owner, "first")).toMatchObject({ ptyID: "pty_retry" })
    promoteTerminal(id, owner, "second")
    await vi.waitFor(() => expect(updates).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(closes).toBe(0)
    expect(await terminalFor(tab, "/terminal-retry", owner, "second")).toMatchObject({ ptyID: "pty_retry" })
    expect(ownerSessionID).toBe("second")
  } finally {
    await stopAllTerminals()
    vi.unstubAllGlobals()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test("remounting a terminal preserves an input reconnect whose handshake is still pending", async () => {
  const owner = await createPanels("terminal-input-reconnect", { get: async () => null, set: async () => {} })
  const id = owner.open({ kind: "terminal", ptyID: "pty_reconnecting" })
  const tab = owner.state.tabs[0]!
  const received: string[] = []
  const wires: Duplex[] = []
  const clients: { socket: WebSocket; closed: Promise<void> }[] = []
  const entered = Promise.withResolvers<void>()
  const handshake = Promise.withResolvers<void>()
  const NativeWebSocket = WebSocket
  vi.stubGlobal(
    "WebSocket",
    class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        const closed = Promise.withResolvers<void>()
        this.addEventListener("close", () => closed.resolve(), { once: true })
        clients.push({ socket: this, closed: closed.promise })
      }
    },
  )
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json")
    response.end(
      request.method === "GET"
        ? JSON.stringify({ id: "pty_reconnecting", status: "running", owner: { tabID: id } })
        : "true",
    )
  })
  server.on("upgrade", (request, socket) => {
    wires.push(socket)
    const second = wires.length === 2
    if (second) entered.resolve()
    void (second ? handshake.promise : Promise.resolve()).then(() => {
      if (socket.destroyed) return
      const accept = createHash("sha1")
        .update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64")
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      )
      let pending = Buffer.alloc(0)
      socket.on("data", (data: Buffer) => {
        pending = Buffer.concat([pending, data])
        // This fixture sends only short, masked text and close frames.
        while (pending.length >= 6) {
          const size = pending[1]! & 0x7f
          if (pending.length < 6 + size) return
          const opcode = pending[0]! & 0x0f
          const value = Buffer.from(pending.subarray(6, 6 + size))
          for (let index = 0; index < size; index++) value[index] = value[index]! ^ pending[2 + (index % 4)]!
          pending = pending.subarray(6 + size)
          if (opcode === 8) return void socket.end(Buffer.from([0x88, 0x00]))
          if (opcode === 1) received.push(value.toString())
        }
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  vi.stubGlobal("location", { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` })
  try {
    await terminalFor(tab, "/terminal-input-reconnect", owner)
    await sendTerminalInput(id, "first")
    await vi.waitFor(() => expect(received).toEqual(["first"]))
    wires[0]!.write(Buffer.from([0x88, 0x02, 0x03, 0xe8]))
    await clients[0]!.closed
    await sendTerminalInput(id, "second")
    await entered.promise
    expect(await terminalFor(tab, "/terminal-input-reconnect", owner)).toEqual({
      directory: "/terminal-input-reconnect",
      ptyID: "pty_reconnecting",
    })
    await sendTerminalInput(id, "third")
    handshake.resolve()
    await vi.waitFor(() => expect(received).toEqual(["first", "second", "third"]))
    expect(wires).toHaveLength(2)
    expect(clients[1]!.socket.readyState).toBe(NativeWebSocket.OPEN)
  } finally {
    handshake.resolve()
    await stopAllTerminals()
    for (const socket of wires) socket.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    vi.unstubAllGlobals()
  }
})
