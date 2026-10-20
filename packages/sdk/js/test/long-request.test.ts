import { afterEach, expect, test } from "vitest"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici"
import { createMerakCodeClient } from "../src/client/index.js"

/**
 * A synchronous prompt only gets its response after the whole turn finishes, which can take tens of minutes for long
 * tasks. Node's fetch waits at most 5 minutes for response headers and 5 minutes between body chunks, then gives up.
 * The test tightens the global default to 0.5 seconds to simulate that limit (instead of waiting 5 minutes); SDK
 * requests must not be bound by it.
 */
const saved = getGlobalDispatcher()
afterEach(() => setGlobalDispatcher(saved))

test("a slow response does not hit fetch's default timeouts in SDK requests", async () => {
  const server = http.createServer((_req, res) =>
    setTimeout(() => {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ id: "ses_1", title: "late" }))
    }, 1500),
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    setGlobalDispatcher(new Agent({ headersTimeout: 500, bodyTimeout: 500 }))
    const client = createMerakCodeClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })
    const result = await client.session.get({ sessionID: "ses_1" })
    expect(result.data).toMatchObject({ id: "ses_1" })
  } finally {
    server.closeAllConnections()
    server.close()
  }
})
