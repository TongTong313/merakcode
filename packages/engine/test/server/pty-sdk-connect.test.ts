import { expect, test } from "vitest"
import { connectPty, createMerakCodeClient } from "@merakcode/sdk/client"
import { Server } from "@merakcode/engine/app/server/server"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"
import { once } from "node:events"
import { WebSocketServer } from "ws"

Log.init({ print: false })

test("the SDK preserves terminal input order when onOpen sends more input", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  server.on("connection", (socket) => socket.on("message", (data) => socket.send(data.toString())))
  await once(server, "listening")
  const address = server.address()
  if (typeof address === "string" || !address) throw new Error("Expected a TCP listener")
  const received: Array<string | ArrayBuffer> = []
  const connection = connectPty({
    baseUrl: `http://127.0.0.1:${address.port}`,
    ptyID: "input-order",
    onData: (data) => received.push(data),
    onOpen: () => connection.send("second"),
  })
  try {
    connection.send("first")
    await expect.poll(() => received, { timeout: 10_000 }).toHaveLength(2)
    expect(received).toEqual(["first", "second"])
  } finally {
    connection.close()
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

test("the SDK queues terminal input before the real WebSocket opens and receives PTY output", async () => {
  await using root = await tmpdir({ git: true })
  const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const client = createMerakCodeClient({ baseUrl: server.url.href, directory: root.path })
  let ptyID: string | undefined
  let connection: ReturnType<typeof connectPty> | undefined
  try {
    const created = await client.pty.create(
      process.platform === "win32" ? { command: "cmd.exe", args: ["/q"] } : { command: "/bin/sh", args: [] },
    )
    const pty = created.data
    expect(pty).toBeDefined()
    ptyID = pty!.id
    const marker = `sdk-pty-${Date.now()}`
    const output = await new Promise<string>((resolve, reject) => {
      let received = ""
      const timer = setTimeout(() => reject(new Error(`PTY output timeout: ${received.slice(0, 300)}`)), 10_000)
      connection = connectPty({
        baseUrl: server.url,
        ptyID: ptyID!,
        directory: root.path,
        onData(data) {
          if (typeof data !== "string") return
          received += data
          if (received.split(marker).length < 3) return
          clearTimeout(timer)
          resolve(received)
        },
        onError(event) {
          clearTimeout(timer)
          reject(new Error(`PTY WebSocket failed: ${String((event as ErrorEvent).error?.stack)}`))
        },
      })
      connection.send(`echo ${marker}\r`)
    })
    expect(output.split(marker).length).toBeGreaterThan(2)
  } finally {
    connection?.close()
    try {
      if (ptyID) await client.pty.remove({ ptyID })
    } finally {
      await server.stop(true)
    }
  }
}, 30_000)
