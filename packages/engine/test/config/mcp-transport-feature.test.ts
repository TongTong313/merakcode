import { expect, test } from "vitest"
import { Config } from "@merakcode/engine/config/config"

test("remote MCP config accepts explicit transport in both variants", () => {
  const parsed = Config.Mcp.safeParse({ type: "remote", url: "https://example.com/mcp", transport: "sse" })
  // Internal and external variants share one schema and both accept transport (internal ignores it), so the same
  // .merakcode/merakcode.json validates under either variant.
  expect(parsed.success).toBe(true)
})
