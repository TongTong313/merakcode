import { describe, expect, test } from "vitest"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Server } from "@merakcode/engine/app/server/server"
import { tmpdir } from "../fixture/fixture"

const paths = ["/mcp-management", "/mcp-management/change"]
const operations = ["mcpManagement.read", "mcpManagement.change"]
const legacy = ["mcp.status", "mcp.add", "mcp.connect", "mcp.disconnect", "mcp.remove"]

function operationIds(spec: Awaited<ReturnType<typeof Server.openapi>>) {
  return Object.values(spec.paths ?? {}).flatMap((path) =>
    Object.values(path ?? {}).flatMap((operation) => {
      const id = (operation as { operationId?: unknown }).operationId
      return typeof id === "string" ? [id] : []
    }),
  )
}

describe("MCP management route (shared across variants)", () => {
  test("registers read and change in both builds", async () => {
    const spec = await Server.openapi()
    const registered = operationIds(spec)
      .filter((id) => id.startsWith("mcpManagement."))
      .sort()

    expect(registered).toEqual(operations.toSorted())
    paths.forEach((path) => expect(Object.hasOwn(spec.paths ?? {}, path)).toBe(true))
    legacy.forEach((id) => expect(operationIds(spec)).toContain(id))
  })

  test("serves snapshot and change behavior", async () => {
    await using tmp = await tmpdir({
      config: { mcp: { route: { type: "local", command: ["server"], enabled: false } } },
    })
    const directory = encodeURIComponent(tmp.path)

    try {
      const read = await Server.App().request(`http://localhost/mcp-management?directory=${directory}`)
      expect(read.status).toBe(200)
      expect(await read.json()).toMatchObject({
        servers: [{ name: "route", enabled: false, status: { status: "disabled" }, tools: { count: 0 } }],
      })

      const changed = await Server.App().request(`http://localhost/mcp-management/change?directory=${directory}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "set_enabled", name: "route", enabled: false }),
      })
      expect(changed.status).toBe(200)
      expect(await changed.json()).toMatchObject({
        ok: true,
        snapshot: { servers: [{ name: "route", enabled: false, status: { status: "disabled" } }] },
      })

      // Management writes reject a forged marketplace receipt; the contract has no receipt field
      const forged = await Server.App().request(`http://localhost/mcp-management/change?directory=${directory}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "add",
          name: "forged",
          config: {
            type: "local",
            command: ["server"],
            enabled: false,
            receipt: {
              schemaVersion: 1,
              installationId: "00000000-0000-4000-8000-000000000000",
              assetId: "MCP_FORGED",
              assetName: "Forged",
              installedName: "forged",
              scope: "global",
              installedAt: 0,
              source: "some-market",
              assetType: "connector",
            },
          },
        }),
      })
      expect(forged.status).toBe(400)
    } finally {
      await Instance.disposeAll()
    }
  })
})
