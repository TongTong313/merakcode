import { describe, expect, test, beforeEach } from "vitest"
import path from "path"
import { pathToFileURL } from "url"
import { LSPClient } from "@merakcode/engine/infra/lsp/client"
import { LSPServer } from "@merakcode/engine/infra/lsp/server"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Log } from "@merakcode/log/logger"

// Minimal fake LSP server that speaks JSON-RPC over stdio
function spawnFakeServer() {
  const { spawn } = require("child_process")
  const serverPath = path.join(__dirname, "../fixture/lsp/fake-lsp-server.cjs")
  return {
    process: spawn(process.execPath, [serverPath], {
      stdio: "pipe",
    }),
  }
}

describe("LSPClient interop", () => {
  beforeEach(async () => {
    await Log.init({ print: true })
  })

  test("handles workspace/workspaceFolders request", async () => {
    const handle = spawnFakeServer() as any

    const client = await Instance.provide({
      directory: process.cwd(),
      fn: () =>
        LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: process.cwd(),
        }),
    })

    await client.connection.sendNotification("test/trigger", {
      method: "workspace/workspaceFolders",
    })

    await new Promise((r) => setTimeout(r, 100))

    expect(client.connection).toBeDefined()

    await client.shutdown()
  })

  test("multi-root initialize exposes every workspace folder", async () => {
    const handle = spawnFakeServer() as any
    const a = process.cwd()
    const b = path.join(process.cwd(), "packages")

    const client = await Instance.provide({
      directory: a,
      workspace: {
        folders: [
          { name: "root", path: a },
          { name: "packages", path: b },
        ],
      },
      fn: () =>
        LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: a,
        }),
    })

    expect(client.connection).toBeDefined()
    const folders = (await client.connection.sendRequest("test/getLastInitializeFolders")) as Array<{
      name: string
      uri: string
    }> | null
    expect(folders).toHaveLength(2)
    expect(folders!.map((f) => f.name).sort()).toEqual(["packages", "root"])
    await client.shutdown()
  })

  test("handles client/registerCapability request", async () => {
    const handle = spawnFakeServer() as any

    const client = await Instance.provide({
      directory: process.cwd(),
      fn: () =>
        LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: process.cwd(),
        }),
    })

    await client.connection.sendNotification("test/trigger", {
      method: "client/registerCapability",
    })

    await new Promise((r) => setTimeout(r, 100))

    expect(client.connection).toBeDefined()

    await client.shutdown()
  })

  test("handles client/unregisterCapability request", async () => {
    const handle = spawnFakeServer() as any

    const client = await Instance.provide({
      directory: process.cwd(),
      fn: () =>
        LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: process.cwd(),
        }),
    })

    await client.connection.sendNotification("test/trigger", {
      method: "client/unregisterCapability",
    })

    await new Promise((r) => setTimeout(r, 100))

    expect(client.connection).toBeDefined()

    await client.shutdown()
  })

  // LSP 3.18 allows Markdown diagnostic messages; what the model and the UI see must be plain text
  test("uses the text of a Markdown diagnostic message", async () => {
    const file = path.join(process.cwd(), "a.ts")
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
    const messages = await Instance.provide({
      directory: process.cwd(),
      fn: async () => {
        // Start the server inside the instance, as production does: diagnostics publish instance events
        const client = await LSPClient.create({
          serverID: "fake",
          server: spawnFakeServer() as unknown as LSPServer.Handle,
          root: process.cwd(),
        })
        await client.connection.sendNotification("test/publish", {
          uri: pathToFileURL(file).href,
          diagnostics: [
            { range, severity: 1, message: { kind: "markdown", value: "Cannot find name `foo`" } },
            { range, severity: 1, message: "plain" },
          ],
        })
        await new Promise((r) => setTimeout(r, 100))
        const [found] = [...client.diagnostics.values()]
        await client.shutdown()
        return found?.map((item) => item.message)
      },
    })
    expect(messages).toEqual(["Cannot find name `foo`", "plain"])
  })
})
