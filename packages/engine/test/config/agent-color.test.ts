import { test, expect } from "vitest"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "@merakcode/engine/project/instance"
import { Config } from "@merakcode/engine/config/config"
import { Agent as AgentSvc } from "@merakcode/engine/agent/agent"
import { Filesystem } from "@merakcode/util/filesystem"

test("agent color parsed from project config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          agent: {
            build: { color: "#FFA500" },
            plan: { color: "primary" },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const cfg = await Config.get()
      expect(cfg.agent?.["build"]?.color).toBe("#FFA500")
      expect(cfg.agent?.["plan"]?.color).toBe("primary")
    },
  })
})

test("Agent.get includes color from config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          agent: {
            plan: { color: "#A855F7" },
            build: { color: "accent" },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const plan = await AgentSvc.get("plan")
      expect(plan?.color).toBe("#A855F7")
      const build = await AgentSvc.get("build")
      expect(build?.color).toBe("accent")
    },
  })
})
