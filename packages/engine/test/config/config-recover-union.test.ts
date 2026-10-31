import { expect, test } from "vitest"
import { Config } from "@merakcode/engine/app/config/files/config"
import { recoverConfig } from "@merakcode/engine/infra/config/recover"

/**
 * An extra field in the config must not make a whole MCP server disappear.
 *
 * `Config.Mcp` is a `discriminatedUnion` whose branches are both `.strict()`, so a single unknown key surfaces as
 * `invalid_union` ("Invalid input") at the item level. Recovery used to drop the whole item, leaving only a vague
 * `config degraded, skipped invalid item` log. The `receipt` field written by an older marketplace hit exactly this.
 */
test("strips unknown fields from an MCP entry and keeps the entry", () => {
  const out = recoverConfig(
    Config.Info,
    { mcp: { market: { type: "remote", url: "https://mcp.test/sse", receipt: { packageId: "p", version: "1" } } } },
    "t.json",
  )
  expect((out.data as { mcp?: Record<string, unknown> }).mcp).toEqual({
    market: { type: "remote", url: "https://mcp.test/sse" },
  })
  // Still records a degradation warning so the UI can prompt the user to fix the file
  expect(out.warnings.map((w) => w.item)).toEqual(["mcp.market"])
})

test("strips only the misspelled key from a local MCP entry", () => {
  const out = recoverConfig(Config.Info, { mcp: { l: { type: "local", command: ["x"], tiemout: 5 } } }, "t.json")
  expect((out.data as { mcp?: Record<string, unknown> }).mcp).toEqual({ l: { type: "local", command: ["x"] } })
})

test("still skips entries that cannot be repaired (validation is not relaxed)", () => {
  // A remote without url fails for reasons other than unknown keys, so the whole item is dropped
  const out = recoverConfig(Config.Info, { mcp: { broken: { type: "remote" } } }, "t.json")
  expect((out.data as { mcp?: Record<string, unknown> }).mcp).toEqual({})
  expect(out.warnings.map((w) => w.item)).toEqual(["mcp.broken"])
})
