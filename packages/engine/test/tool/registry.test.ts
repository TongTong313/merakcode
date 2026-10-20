import { test, expect } from "vitest"
import path from "path"
import { mkdir, symlink } from "fs/promises"
import { fileURLToPath } from "url"
import { Config } from "@merakcode/engine/config/config"
import { Instance } from "@merakcode/engine/project/instance"
import { ToolRegistry } from "@merakcode/engine/tool/registry"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

test("ToolRegistry includes todowrite and subagent but not todoread or task", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ids = await ToolRegistry.ids()
      expect(ids).not.toContain("todoread")
      expect(ids).toContain("todowrite")
      expect(ids).toContain("subagent")
      expect(ids).not.toContain("task")
      expect(ids).not.toContain("apply_patch")
    },
  })
})

test("ToolRegistry.tools exposes edit, write and multi_edit but not apply_patch for every model", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const models = [
        { providerID: "openai", modelID: "gpt-5" },
        { providerID: "openai", modelID: "gpt-5-mini" },
        { providerID: "anthropic", modelID: "claude-sonnet-4" },
      ]
      for (const model of models) {
        const ids = new Set((await ToolRegistry.tools(model)).map((t) => t.id))
        expect(ids.has("edit")).toBe(true)
        expect(ids.has("write")).toBe(true)
        expect(ids.has("multi_edit")).toBe(true)
        expect(ids.has("apply_patch")).toBe(false)
      }
    },
  })
})

test("ToolRegistry does not import explicitly disabled project tools", async () => {
  await using tmp = await tmpdir()
  const dir = `${tmp.path}/.merakcode`
  await mkdir(`${dir}/tool`, { recursive: true })
  await Filesystem.write(
    `${dir}/merakcode.jsonc`,
    `{
  "tools": {
    "broken-tool": false
  }
}`,
  )
  await Filesystem.write(
    `${dir}/tool/broken-tool.ts`,
    `import "missing-package-for-disabled-custom-tool"

export default {}
`,
  )

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ids = await ToolRegistry.ids()
      expect(ids).not.toContain("broken-tool")
    },
  })
})

test("ToolRegistry registers interactive tools by client and noninteractive flag", async () => {
  const cases = [
    { client: "sdk", noninteractive: false, enabled: true },
    { client: "desktop", noninteractive: false, enabled: true },
    { client: "tui", noninteractive: false, enabled: true },
    { client: "cli", noninteractive: false, enabled: true },
    { client: "acp", noninteractive: false, enabled: false },
    { client: "unknown", noninteractive: false, enabled: false },
    { client: "web", noninteractive: false, enabled: false },
    { client: "sdk", noninteractive: true, enabled: false },
  ]

  const originalClient = process.env.MERAKCODE_CLIENT
  const originalNoninteractive = process.env.MERAKCODE_NONINTERACTIVE

  try {
    for (const item of cases) {
      await using tmp = await tmpdir()
      process.env.MERAKCODE_CLIENT = item.client
      if (item.noninteractive) process.env.MERAKCODE_NONINTERACTIVE = "true"
      else delete process.env.MERAKCODE_NONINTERACTIVE

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const ids = await ToolRegistry.ids()

          for (const id of ["question", "plan_enter", "plan_exit"]) {
            if (item.enabled) expect(ids).toContain(id)
            else expect(ids).not.toContain(id)
          }
        },
      })
    }
  } finally {
    if (originalClient === undefined) delete process.env.MERAKCODE_CLIENT
    else process.env.MERAKCODE_CLIENT = originalClient

    if (originalNoninteractive === undefined) delete process.env.MERAKCODE_NONINTERACTIVE
    else process.env.MERAKCODE_NONINTERACTIVE = originalNoninteractive
  }
})

test("project tools defined with @merakcode/sdk/plugin load offline through the local shim", async () => {
  await using tmp = await tmpdir()
  const dir = path.join(tmp.path, ".merakcode")
  // Link zod in so nothing is installed from npm
  await mkdir(path.join(dir, "node_modules"), { recursive: true })
  await symlink(
    path.dirname(fileURLToPath(import.meta.resolve("zod"))),
    path.join(dir, "node_modules", "zod"),
    process.platform === "win32" ? "junction" : "dir",
  )
  await Filesystem.write(
    path.join(dir, "tool", "greet.ts"),
    [
      `import { tool } from "@merakcode/sdk/plugin"`,
      `export default tool({`,
      `  description: "Greet someone",`,
      `  args: { name: tool.schema.string() },`,
      `  async execute(args) { return "hello " + args.name },`,
      `})`,
    ].join("\n"),
  )

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect(await ToolRegistry.ids()).toContain("greet")
    },
  })
})

test("a real @merakcode/sdk in the config directory is not overwritten by the shim", async () => {
  await using tmp = await tmpdir()
  await mkdir(path.join(tmp.path, "node_modules", "zod"), { recursive: true })
  const real = path.join(tmp.path, "node_modules", "@merakcode", "sdk", "package.json")
  await Filesystem.write(real, JSON.stringify({ name: "@merakcode/sdk", version: "9.9.9" }))

  await Config.installDependencies(tmp.path)

  expect(await Filesystem.readJson(real)).toEqual({ name: "@merakcode/sdk", version: "9.9.9" })
})
