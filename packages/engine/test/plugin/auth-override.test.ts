import { describe, expect, test } from "vitest"
import path from "path"
import fs from "fs/promises"
import { fileURLToPath } from "url"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "@merakcode/engine/project/instance"
import { ProviderAuth } from "@merakcode/engine/provider/auth"
import { Filesystem } from "@merakcode/util/filesystem"

describe("plugin.auth", () => {
  test("a project plugin can register login methods for a provider", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const configDir = path.join(dir, ".merakcode")
        const pluginDir = path.join(configDir, "plugin")
        await fs.mkdir(pluginDir, { recursive: true })
        const modules = path.join(configDir, "node_modules")
        await fs.mkdir(modules, { recursive: true })
        await fs.symlink(
          path.dirname(fileURLToPath(import.meta.resolve("zod"))),
          path.join(modules, "zod"),
          process.platform === "win32" ? "junction" : "dir",
        )

        await Filesystem.write(
          path.join(pluginDir, "custom-auth.ts"),
          [
            "export default async () => ({",
            "  auth: {",
            '    provider: "acme-ai",',
            "    methods: [",
            '      { type: "api", label: "Test Auth" },',
            "    ],",
            "    loader: async () => ({ access: 'test-token' }),",
            "  },",
            "})",
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const methods = (await ProviderAuth.methods())["acme-ai"]
        expect(methods).toBeDefined()
        expect(methods.length).toBe(1)
        expect(methods[0].label).toBe("Test Auth")
      },
    })
  }, 30000)
})
