import { createServer, type ServerResponse } from "node:http"
import { addAbortListener } from "node:events"
import { createRoot } from "solid-js"
import { expect, test } from "vitest"
import { useGitChanges } from "../features/git/changes"
import { updateCheckout } from "./git"
import { connect, listen, setState, state } from "./store"

test("directoryless global events in the Git panel preserve the following session events", async () => {
  const stream = Promise.withResolvers<ServerResponse>()
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/global/event")) {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.flushHeaders()
      stream.resolve(response)
      return
    }
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ checkout: null, staged: [], unstaged: [] }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Event fixture did not listen")
  location.href = `http://127.0.0.1:${address.port}`
  const dispose = createRoot((dispose) => {
    useGitChanges(() => "/project")
    return dispose
  })
  const seen: string[] = []
  const stopBroken = listen((_directory, event) => {
    if (event.type === "config.updated") throw new Error("Listener failure probe")
  })
  const unlisten = listen((directory, event) => {
    if (event.type === "config.updated") seen.push(directory)
  })
  const disconnect = connect()
  try {
    setState("sessions", "session_status", "event-probe", { type: "busy" })
    const response = await stream.promise
    const events = [
      { payload: { type: "server.heartbeat", properties: {} } },
      { payload: { type: "config.updated", properties: {} } },
      {
        directory: "/project",
        payload: { type: "session.status", properties: { sessionID: "event-probe", status: { type: "idle" } } },
      },
    ]
    response.write(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""))
    await expect.poll(() => state.sessions.session_status["event-probe"]?.type, { timeout: 10_000 }).toBe("idle")
    expect(seen).toEqual(["global"])
  } finally {
    disconnect()
    stopBroken()
    unlisten()
    dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test("Git changes remain readable when a background refresh arrives during the initial load", async ({ signal }) => {
  const first = Promise.withResolvers<ServerResponse>()
  const held: ServerResponse[] = []
  let entered = false
  let closing = false
  const result = {
    checkout: "observed-checkout",
    staged: [],
    unstaged: [{ file: "new.txt", status: "untracked", version: "v1" }],
  }
  const send = (response: ServerResponse) => response.end(JSON.stringify(result))
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    if (closing) return void send(response)
    if (!entered) {
      entered = true
      first.resolve(response)
      return
    }
    held.push(response)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Git fixture did not listen")
  location.href = `http://127.0.0.1:${address.port}`
  const directory = "/background-refresh-project"
  const { changes, dispose } = createRoot((dispose) => ({ changes: useGitChanges(() => directory), dispose }))
  try {
    using _abort = addAbortListener(signal, () => first.reject(signal.reason))
    const response = await first.promise
    updateCheckout(directory, { branch: "main", head: "head", checkout: result.checkout })
    send(response)
    // Later responses remain held: the first valid snapshot must already be usable.
    await expect.poll(() => changes.data()?.unstaged.map((file) => file.file)).toEqual(["new.txt"])
  } finally {
    closing = true
    dispose()
    for (const response of held) send(response)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
