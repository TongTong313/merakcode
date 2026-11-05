import { createServer } from "node:http"
import { expect, test, vi } from "vitest"
import { createPanels } from "../panel/state"
import { promoteTerminal, stopAllTerminals, terminalFor } from "./resource"

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
