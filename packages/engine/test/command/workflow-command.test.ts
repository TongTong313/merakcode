import { describe, expect, test } from "vitest"
import fs from "fs/promises"
import path from "path"
import { Command } from "@merakcode/engine/agent/prompt/command/index"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

describe("workflow slash commands", () => {
  test("there is no generic /workflow command; each named workflow gets its own launch command", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, ".merakcode", "workflows"), { recursive: true })
        await Filesystem.write(
          path.join(dir, ".merakcode", "workflows", "audit.js"),
          [
            "export const meta = {",
            "  name: 'audit',",
            "  description: 'Audit workflow',",
            "  phases: ['Scan']",
            "}",
            "return await agent('scan')",
          ].join("\n"),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await Command.get("workflow")).toBeUndefined()

        const named = await Command.get("audit")
        expect(named?.agent).toBeUndefined()
        expect(await named?.template).toContain("workflow_run")
      },
    })
  })
})
