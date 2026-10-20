import { expect, test } from "vitest"
import path from "node:path"
import { Command } from "../../src/command"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { MCP } from "../../src/mcp"
import { tmpdir, runtime } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

test("config invalidation refreshes commands without disposing the live Instance", async () => {
  await using tmp = await tmpdir({ config: { command: { changing: { template: "old template" } } } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect(await (await Command.get("changing"))?.template).toBe("old template")
      await Filesystem.write(
        path.join(tmp.path, "merakcode.json"),
        JSON.stringify({ command: { changing: { template: "new template" } } }),
      )
      // Same invalidation used by ConfigWatch for external project config writes.
      Config.state.invalidate()
      expect(await (await Command.get("changing"))?.template).toBe("new template")
    },
  })
})

test("MCP disconnect and reconnect invalidate cached prompt commands", async () => {
  await using tmp = await tmpdir({
    config: {
      mcp: {
        fixture: {
          type: "local",
          enabled: true,
          command: [...runtime, path.join(import.meta.dirname, "fixtures/prompt-server.ts")],
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      try {
        const first = await Command.get("fixture:greeting")
        expect(first?.source).toBe("mcp")
        expect(await first?.template).toBe("Hello $1")
        await MCP.disconnect("fixture")
        expect(await Command.get("fixture:greeting")).toBeUndefined()
        await MCP.connect("fixture")
        const reconnected = await Command.get("fixture:greeting")
        expect(reconnected?.source).toBe("mcp")
        expect(await reconnected?.template).toBe("Hello $1")
      } finally {
        await MCP.disconnect("fixture")
      }
    },
  })
})
