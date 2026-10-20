import { test, expect, vi } from "vitest"
import path from "path"
import { Filesystem } from "@merakcode/util/filesystem"

// Mock the MCP client and stdio transport so local servers "connect", to verify that deletion disconnects the
// runtime before removing the config.
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    async connect() {}
    setNotificationHandler() {}
    async listTools() {
      return { tools: [{ name: "t" }] }
    }
    async callTool() {
      return {}
    }
    async close() {}
  },
}))
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    get stderr() {
      return null
    }
    async start() {}
    async close() {}
  },
}))

const { MCP } = await import("@merakcode/engine/mcp/index")
const { Instance } = await import("@merakcode/engine/project/instance")
const { tmpdir } = await import("../fixture/fixture")

const LOCAL = { type: "local" as const, command: ["dummy"], enabled: true }

test("deleteMcpServer removes mcp[name] from the project config and status no longer lists it", async () => {
  await using tmp = await tmpdir({ config: { mcp: { alpha: LOCAL, beta: LOCAL } } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect(Object.keys(await MCP.status()).sort()).toEqual(["alpha", "beta"])
      await MCP.deleteMcpServer("alpha", "project")
      const status = await MCP.status()
      expect(status["alpha"]).toBeUndefined()
      expect(status["beta"]).toBeDefined()
      const written = await Filesystem.readText(path.join(tmp.path, "merakcode.json"))
      expect(written).not.toContain("alpha")
      expect(written).toContain("beta")
    },
  })
})

test("deleting a missing server does not fail (idempotent)", async () => {
  await using tmp = await tmpdir({ config: { mcp: { alpha: LOCAL } } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await MCP.deleteMcpServer("ghost", "project")
      expect((await MCP.status())["alpha"]).toBeDefined()
    },
  })
})
