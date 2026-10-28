import { createServer, type ServerResponse } from "node:http"
import { createRoot } from "solid-js"
import { expect, test } from "vitest"
import { useGitChanges } from "../features/git/changes"
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
