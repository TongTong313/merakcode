import { expect, test } from "vitest"
import { createServer } from "node:net"
import { Server } from "@merakcode/engine/server/server"
import { Sandbox } from "@merakcode/engine/sandbox/index"
import { Log } from "@merakcode/log/logger"

Log.init({ print: false })

test("starting the engine prepares an already set up sandbox", async () => {
  const previous = process.env.MERAKCODE_SANDBOX_MODE
  process.env.MERAKCODE_SANDBOX_MODE = "preferred"
  let prepared = false
  Sandbox.useBackendForTest({
    status: async () => ({ status: "on", backend: "landlock" }),
    warm: async () => {
      prepared = true
    },
    wrap: async () => {
      throw new Error("unused")
    },
  })
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  try {
    expect(prepared).toBe(true)
  } finally {
    await listener.stop(true)
    Sandbox.useBackendForTest(undefined)
    if (previous === undefined) delete process.env.MERAKCODE_SANDBOX_MODE
    else process.env.MERAKCODE_SANDBOX_MODE = previous
  }
})

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
