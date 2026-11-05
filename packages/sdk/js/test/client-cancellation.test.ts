import { expect, test } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { setTimeout as delay } from "node:timers/promises"
import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"
import { createMerakCodeClient } from "@merakcode/sdk/client"

test.each(["headers", "body"])("SDK cancellation survives garbage collection while waiting for %s", async (phase) => {
  const received = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<void>()
  const server = createServer((_request, response) => {
    response.on("close", closed.resolve)
    if (phase === "body") {
      response.writeHead(200, { "content-type": "application/json" })
      response.write("{")
    }
    received.resolve()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const client = createMerakCodeClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })
  const controller = new AbortController()
  const pending = client.workflow
    .cancel({ sessionID: "local-session", runId: "local-run" }, { signal: controller.signal, throwOnError: true })
    .then(
      () => "resolved",
      (error: Error) => error.name,
    )
  try {
    await received.promise
    setFlagsFromString("--expose-gc")
    const collect = runInNewContext("gc") as () => void
    for (let index = 0; index < 8; index++) {
      await delay(25)
      collect()
    }
    controller.abort()
    expect(await Promise.race([pending, delay(1000).then(() => "still pending")])).toBe("AbortError")
    await closed.promise
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await pending
  }
})
