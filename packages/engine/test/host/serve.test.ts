import { describe, expect, test } from "vitest"
import { EngineHost } from "@merakcode/engine/host"
import { resolveNetwork } from "@merakcode/engine/app/host/serve"
import { tmpdir } from "../fixture/fixture"
import { PermissionExecution } from "@merakcode/engine/agent/permission/execution"
import { EngineAddress } from "@merakcode/engine/infra/process/engine-address"
import { evaluate } from "../fixture/fixture"
import { Process } from "@merakcode/util/process"
import { pathToFileURL } from "node:url"
import path from "node:path"

const defaults = { hostname: "127.0.0.1", mdns: false, "mdns-domain": "merakcode.local", cors: [] as string[] }

describe("EngineHost.serve", () => {
  test("a failed bind releases global watcher timers", async () => {
    const source = pathToFileURL(path.resolve(import.meta.dirname, "../../src/app/host/index.ts")).href
    const result = await Process.run(
      evaluate(`
      const { createServer } = await import("node:net")
      const blocker = createServer()
      await new Promise(resolve => blocker.listen(0, "127.0.0.1", resolve))
      const { EngineHost } = await import(${JSON.stringify(source)})
      try {
        await EngineHost.serve({ hostname: "127.0.0.1", port: blocker.address().port, mdns: false, "mdns-domain": "merakcode.local" }, { waitForShutdown: async () => { throw new Error("Unexpected listener") } })
        throw new Error("Expected a bind failure")
      } catch (error) {
        if (!error.message.includes("Failed to start server")) throw error
        console.log("failed-cleanly")
      } finally {
        await new Promise(resolve => blocker.close(resolve))
        await EngineHost.cleanup()
        if (process.getActiveResourcesInfo().includes("Timeout")) throw new Error("Global watcher timers survived failed startup")
        process.exit(0)
      }
    `),
      { env: { ...process.env }, signal: AbortSignal.timeout(10_000), nothrow: true },
    )
    expect(result.exitCode, result.text() + result.stderr.toString()).toBe(0)
    expect(result.text()).toContain("failed-cleanly")
  }, 15_000)
  test("prepares an existing sandbox and records the actual listener port", async () => {
    const previous = process.env.MERAKCODE_SANDBOX_MODE
    process.env.MERAKCODE_SANDBOX_MODE = "preferred"
    let prepared = false
    let listenerPort: number | undefined
    const previousPort = EngineAddress.port()
    PermissionExecution.useBackendForTest({
      status: async () => ({ status: "on", backend: "landlock" }),
      warm: async () => {
        expect(EngineAddress.port()).toBe(previousPort)
        prepared = true
      },
      wrap: async () => {
        throw new Error("unused")
      },
    })
    try {
      await EngineHost.serve(
        { ...defaults, port: 0 },
        {
          waitForShutdown: async (cleanup) => {
            try {
              expect(prepared).toBe(true)
              expect(EngineAddress.port()).toBe(listenerPort)
            } finally {
              await cleanup()
            }
          },
          onListening: (url) => (listenerPort = Number(url.port)),
        },
      )
    } finally {
      PermissionExecution.useBackendForTest(undefined)
      if (previous === undefined) delete process.env.MERAKCODE_SANDBOX_MODE
      else process.env.MERAKCODE_SANDBOX_MODE = previous
    }
  })

  test("listens on a free port, answers requests, and stops when shutdown is requested", async () => {
    await using tmp = await tmpdir()
    let url: URL | undefined
    let health: number | undefined
    let project: number | undefined
    await EngineHost.serve(
      { ...defaults, port: 0 },
      {
        onListening: (address) => (url = address),
        waitForShutdown: async (cleanup) => {
          health = (await fetch(new URL("/global/health", url))).status
          // Opens a project instance, so shutdown has instance-scoped work to drain
          project = (await fetch(new URL(`/path?directory=${encodeURIComponent(tmp.path)}`, url))).status
          await cleanup()
        },
      },
    )
    expect(url?.port).not.toBe("0")
    expect(health).toBe(200)
    expect(project).toBe(200)
    await expect(fetch(new URL("/global/health", url))).rejects.toThrow()
  }, 60_000)
})

describe("resolveNetwork", () => {
  test("uses command-line values only when they were passed explicitly", async () => {
    const implicit = await resolveNetwork({ ...defaults, port: 4096 }, ["node", "merak", "serve"])
    expect(implicit).toMatchObject({ hostname: "127.0.0.1", port: 4096, mdns: false })
    const explicit = await resolveNetwork({ ...defaults, port: 5000, hostname: "0.0.0.0" }, [
      "node",
      "merak",
      "serve",
      "--port",
      "5000",
      "--hostname",
      "0.0.0.0",
    ])
    expect(explicit).toMatchObject({ hostname: "0.0.0.0", port: 5000 })
  })

  test("mDNS without an explicit hostname listens on all interfaces", async () => {
    const result = await resolveNetwork({ ...defaults, mdns: true }, ["node", "merak", "serve", "--mdns"])
    expect(result.hostname).toBe("0.0.0.0")
  })
})
