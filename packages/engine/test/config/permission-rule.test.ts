import { expect, test } from "vitest"
import path from "path"
import { Config } from "@merakcode/engine/config/config"
import { Instance } from "@merakcode/engine/project/instance"
import { Filesystem } from "@merakcode/util/filesystem"
import { tmpdir } from "../fixture/fixture"

// The settings page and /permissions panel add, change or remove one rule without touching anything else in the
// config file (comments, other fields)

test("adds a rule to project .merakcode/merakcode.json, then changes and removes it", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Config.setPermissionRule({ scope: "project", permission: "bash", pattern: "npm test *", action: "allow" })
      await Config.setPermissionRule({
        scope: "project",
        permission: "network",
        pattern: "example.com",
        action: "deny",
      })
      expect((await Config.loadProjectMerakCodeFile()).permission).toEqual({
        bash: { "npm test *": "allow" },
        network: { "example.com": "deny" },
      })
      expect((await Config.get()).permission).toMatchObject({ bash: { "npm test *": "allow" } })

      await Config.setPermissionRule({ scope: "project", permission: "bash", pattern: "npm test *", action: "ask" })
      await Config.setPermissionRule({ scope: "project", permission: "network", pattern: "example.com" })
      expect((await Config.loadProjectMerakCodeFile()).permission).toEqual({ bash: { "npm test *": "ask" } })

      await Config.setPermissionRule({ scope: "project", permission: "bash", pattern: "npm test *" })
      expect((await Config.loadProjectMerakCodeFile()).permission).toBeUndefined()
    },
  })
})

test('converting a whole-key rule ("bash": "ask") to patterns keeps the old default, comments and other fields', async () => {
  await using tmp = await tmpdir({
    git: true,
    init: (dir) =>
      Filesystem.write(
        path.join(dir, ".merakcode", "merakcode.jsonc"),
        `{
  // 我的设置
  "model": "alibaba-cn/qwen-plus",
  "permission": { "bash": "ask" }
}
`,
      ),
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Config.setPermissionRule({ scope: "project", permission: "bash", pattern: "git push *", action: "deny" })
      const text = await Filesystem.readText(path.join(tmp.path, ".merakcode", "merakcode.jsonc"))
      expect(text).toContain("// 我的设置")
      expect(text).toContain('"model": "alibaba-cn/qwen-plus"')
      expect((await Config.loadProjectMerakCodeFile()).permission).toEqual({
        bash: { "*": "ask", "git push *": "deny" },
      })
    },
  })
})
