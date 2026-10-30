import { test, expect, beforeEach, vi } from "vitest"
import { Filesystem } from "@merakcode/util/filesystem"

// Track what options were passed to each transport constructor
const transportCalls: Array<{
  type: "streamable" | "sse"
  url: string
  options: { authProvider?: unknown; requestInit?: RequestInit }
}> = []

// Mock the transport constructors to capture their arguments
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTP {
    constructor(url: URL, options?: { authProvider?: unknown; requestInit?: RequestInit }) {
      transportCalls.push({
        type: "streamable",
        url: url.toString(),
        options: options ?? {},
      })
    }
    async start() {
      throw new Error("Mock transport cannot connect")
    }
  },
}))

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSSE {
    constructor(url: URL, options?: { authProvider?: unknown; requestInit?: RequestInit }) {
      transportCalls.push({
        type: "sse",
        url: url.toString(),
        options: options ?? {},
      })
    }
    async start() {
      throw new Error("Mock transport cannot connect")
    }
  },
}))

beforeEach(() => {
  transportCalls.length = 0
})

// Import MCP after mocking
const { MCP } = await import("@merakcode/engine/agent/mcp/index")
const { Config } = await import("@merakcode/engine/app/config/files/config")
const { Instance } = await import("@merakcode/engine/infra/project/instance")
const { tmpdir } = await import("../fixture/fixture")

test("headers are passed to transports by default", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        `${dir}/merakcode.json`,
        JSON.stringify({
          $schema: Config.SCHEMA,
          mcp: {
            "test-server": {
              type: "remote",
              url: "https://example.com/mcp",
              headers: {
                Authorization: "Bearer test-token",
                "X-Custom-Header": "custom-value",
              },
            },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Trigger MCP initialization - it will fail to connect but we can check the transport options
      await MCP.add("test-server", {
        type: "remote",
        url: "https://example.com/mcp",
        headers: {
          Authorization: "Bearer test-token",
          "X-Custom-Header": "custom-value",
        },
      }).catch(() => {})

      // Both transports should have been created with headers
      expect(transportCalls.length).toBeGreaterThanOrEqual(1)

      for (const call of transportCalls) {
        expect(call.options.requestInit).toBeDefined()
        expect(call.options.requestInit?.headers).toEqual({
          Authorization: "Bearer test-token",
          "X-Custom-Header": "custom-value",
        })
        expect(call.options.authProvider).toBeUndefined()
      }
    },
  })
})

test("headers are passed to transports when oauth is explicitly disabled", async () => {
  await using tmp = await tmpdir()

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      transportCalls.length = 0

      await MCP.add("test-server-no-oauth", {
        type: "remote",
        url: "https://example.com/mcp",
        headers: {
          Authorization: "Bearer test-token",
        },
      }).catch(() => {})

      expect(transportCalls.length).toBeGreaterThanOrEqual(1)

      for (const call of transportCalls) {
        expect(call.options.requestInit).toBeDefined()
        expect(call.options.requestInit?.headers).toEqual({
          Authorization: "Bearer test-token",
        })
        // OAuth is disabled, so no authProvider
        expect(call.options.authProvider).toBeUndefined()
      }
    },
  })
})

test("no requestInit when headers are not provided", async () => {
  await using tmp = await tmpdir()

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      transportCalls.length = 0

      await MCP.add("test-server-no-headers", {
        type: "remote",
        url: "https://example.com/mcp",
      }).catch(() => {})

      expect(transportCalls.length).toBeGreaterThanOrEqual(1)

      for (const call of transportCalls) {
        // No headers means requestInit should be undefined
        expect(call.options.requestInit).toBeUndefined()
      }
    },
  })
})

test("explicit remote transport selects protocol with http fallback to sse", async () => {
  await using tmp = await tmpdir()

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // http: StreamableHTTP first, falling back to SSE (covers old Alibaba Cloud Bailian configs without a transport)
      transportCalls.length = 0
      await MCP.add(
        "explicit-http",
        Config.Mcp.parse({ type: "remote", transport: "http", url: "https://example.com/http" }),
      ).catch(() => undefined)
      expect(transportCalls.map((call) => call.type)).toEqual(["streamable", "sse"])

      // sse: SSE only
      transportCalls.length = 0
      await MCP.add(
        "explicit-sse",
        Config.Mcp.parse({ type: "remote", transport: "sse", url: "https://example.com/sse" }),
      ).catch(() => undefined)
      expect(transportCalls.map((call) => call.type)).toEqual(["sse"])
    },
  })
})

test("remote config without transport preserves HTTP then SSE auto detection", async () => {
  await using tmp = await tmpdir()

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      transportCalls.length = 0
      await MCP.add("auto", { type: "remote", url: "https://example.com/auto" }).catch(() => undefined)
      expect(transportCalls.map((call) => call.type)).toEqual(["streamable", "sse"])
    },
  })
})
