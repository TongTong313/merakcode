// MCP tools load eagerly unless deferred is explicitly true; unset stays undefined. Local and remote behave the same.
import { describe, expect, test } from "vitest"
import { Config } from "./config"

describe("Config.Mcp deferred", () => {
  test("McpLocal leaves deferred undefined when unset (eager at runtime)", () => {
    const parsed = Config.Mcp.parse({
      type: "local",
      command: ["node", "server.js"],
    })
    expect(parsed.deferred).toBeUndefined()
  })

  test("McpLocal keeps an explicit deferred: false (eager)", () => {
    const parsed = Config.Mcp.parse({
      type: "local",
      command: ["node", "server.js"],
      deferred: false,
    })
    expect(parsed.deferred).toBe(false)
  })

  test("McpLocal keeps an explicit deferred: true (deferred)", () => {
    const parsed = Config.Mcp.parse({
      type: "local",
      command: ["node", "server.js"],
      deferred: true,
    })
    expect(parsed.deferred).toBe(true)
  })

  test("McpRemote supports deferred too", () => {
    const parsed = Config.Mcp.parse({
      type: "remote",
      url: "http://example.com/mcp",
      deferred: false,
    })
    expect(parsed.deferred).toBe(false)
  })

  test("McpRemote leaves deferred undefined when unset (eager)", () => {
    const parsed = Config.Mcp.parse({
      type: "remote",
      url: "http://example.com/mcp",
    })
    expect(parsed.deferred).toBeUndefined()
  })
})
