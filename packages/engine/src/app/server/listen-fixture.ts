// Starts a real engine server in its own process and checks HTTP, the terminal WebSocket and stopping over the real
// network. The result is printed to stdout as one line of JSON.
import WebSocket from "ws"
import { Server } from "./server"
import { Log } from "@merakcode/log/logger"

await Log.init({ print: false, component: "listen-fixture", trackRun: false })

const authorization = `Basic ${Buffer.from("listen-fixture:fixture-password").toString("base64")}`
const directory = process.cwd()
const result: Record<string, unknown> = {}

const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
result.port = listener.port > 0
result.url = listener.url.href === `http://127.0.0.1:${listener.port}/`
result.hostname = listener.hostname
result.sealed = process.env.MERAKCODE_SERVER_PASSWORD === undefined

const health = await fetch(new URL("/global/health", listener.url), { headers: { authorization } })
result.health = health.status

const created = await fetch(new URL(`/pty?directory=${encodeURIComponent(directory)}`, listener.url), {
  method: "POST",
  headers: { authorization, "content-type": "application/json" },
  body: JSON.stringify(
    process.platform === "win32" ? { command: "cmd.exe", args: ["/q"] } : { command: "/bin/sh", args: [] },
  ),
})
const pty = (await created.json()) as { id: string }
result.created = created.status

const socketUrl = new URL(`/pty/${pty.id}/connect?directory=${encodeURIComponent(directory)}`, listener.url)
socketUrl.protocol = "ws:"
// The input echo shows "echo listen-ok" once and the command output shows "listen-ok" again. ConPTY moves the cursor
// instead of printing \n, so count occurrences rather than lines.
const failure: string[] = []
result.echo = await new Promise<boolean>((resolve) => {
  const socket = new WebSocket(socketUrl, { headers: { authorization } })
  let output = ""
  const done = (ok: boolean) => {
    clearTimeout(timer)
    socket.close()
    if (!ok) failure.push(`output: ${JSON.stringify(output.slice(0, 300))}`)
    resolve(ok)
  }
  const timer = setTimeout(() => done(false), 10_000)
  socket.on("open", () => socket.send("echo listen-ok\r"))
  socket.on("message", (data) => {
    output += data.toString()
    if (output.split("listen-ok").length > 2) done(true)
  })
  socket.on("error", (error) => {
    failure.push(`socket error: ${error.message}`)
    done(false)
  })
})
if (failure.length) console.error(failure.join("\n"))

await fetch(new URL(`/pty/${pty.id}?directory=${encodeURIComponent(directory)}`, listener.url), {
  method: "DELETE",
  headers: { authorization },
})
await listener.stop(true)
result.stopped = await fetch(new URL("/global/health", listener.url), { headers: { authorization } }).then(
  () => false,
  () => true,
)

console.log(JSON.stringify(result))
process.exit(0)
