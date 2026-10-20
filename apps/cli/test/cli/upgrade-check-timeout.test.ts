import { expect, test } from "vitest"
import { createServer, type Socket } from "node:net"
import { Installation } from "../../src/cli/installation"
import { setTimeout as delay } from "node:timers/promises"

/**
 * For npm installs the version lookup runs in the upgrade check after startup and must enforce its own timeout: a bare
 * fetch waits for the OS-level TCP timeout. A server that accepts but never sends a byte reproduces a reachable host
 * that does not respond.
 */
test("the npm version lookup times out when the server never responds instead of hanging", async () => {
  // Track connections: an implementation without a timeout keeps this socket open, and unless it is destroyed
  // server.close() never sees it close and the whole test process hangs
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const port = (server.address() as { port: number }).port

  const original = process.env.MERAKCODE_NPM_REGISTRY
  process.env.MERAKCODE_NPM_REGISTRY = `http://127.0.0.1:${port}`
  try {
    const started = Date.now()
    // Race against a timer instead of awaiting directly: an implementation without a timeout would hang, turning
    // "watch it fail" into "watch it hang"
    const outcome = await Promise.race([
      Installation.latest("npm").then(
        () => "settled",
        () => "settled",
      ),
      delay(5_000).then(() => "hanging"),
    ])

    expect(outcome).toBe("settled")
    // 4 s limit = the 3 s product timeout + 1 s margin; an implementation without a timeout lands in the 5 s branch
    expect(Date.now() - started).toBeLessThan(4_000)
  } finally {
    if (original === undefined) delete process.env.MERAKCODE_NPM_REGISTRY
    else process.env.MERAKCODE_NPM_REGISTRY = original
    for (const socket of sockets) socket.destroy()
    server.close()
  }
}, 20_000)
