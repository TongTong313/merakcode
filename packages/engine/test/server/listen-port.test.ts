import { expect, test } from "vitest"
import { createServer } from "node:net"
import { Server } from "@merakcode/engine/server/server"
import { Log } from "@merakcode/log/logger"

Log.init({ print: false })

test("port 0 lets the OS pick a port instead of 4096, as the SDK, CLI and desktop engines start", async () => {
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  try {
    expect(listener.port).toBeGreaterThan(0)
    expect(listener.port).not.toBe(4096)
  } finally {
    await listener.stop(true)
  }
})

test("without a port, prefers 4096 and lets the OS pick when it is taken", async () => {
  const blocker = createServer()
  await new Promise<void>((resolve) => blocker.once("error", () => resolve()).listen(4096, "127.0.0.1", resolve))
  const listener = await Server.listen({ hostname: "127.0.0.1" })
  try {
    expect(listener.port).toBeGreaterThan(0)
    expect(listener.port).not.toBe(4096)
  } finally {
    await listener.stop(true)
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
  }
})
