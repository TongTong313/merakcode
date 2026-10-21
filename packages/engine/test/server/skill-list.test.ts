import { afterEach, describe, expect, test } from "vitest"
import path from "path"
import fs from "fs/promises"
import { Server } from "@merakcode/engine/server/server"
import { Log } from "@merakcode/log/logger"
import { globalConfig, tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

Log.init({ print: false })

const skillMd = (name: string) => `---
name: ${name}
description: test skill
---

# Test
`

describe("skill routes", () => {
  const envBackup = {
    home: process.env.MERAKCODE_TEST_HOME,
    disableProject: process.env.MERAKCODE_DISABLE_PROJECT_CONFIG,
  }

  afterEach(() => {
    process.env.MERAKCODE_TEST_HOME = envBackup.home
    process.env.MERAKCODE_DISABLE_PROJECT_CONFIG = envBackup.disableProject
  })

  test("uninstalling a global ~/.merakcode skill keeps the project skill with the same name", async () => {
    await using home = await tmpdir()
    await using project = await tmpdir({ git: true })

    process.env.MERAKCODE_TEST_HOME = home.path
    using _ = globalConfig(path.join(home.path, ".merakcode"))

    const globalDir = path.join(home.path, ".merakcode", "skills", "user-mgmt")
    const projectDir = path.join(project.path, ".merakcode", "skills", "user-mgmt")
    await fs.mkdir(globalDir, { recursive: true })
    await fs.mkdir(projectDir, { recursive: true })
    await Filesystem.write(path.join(globalDir, "SKILL.md"), skillMd("user-mgmt"))
    await Filesystem.write(path.join(projectDir, "SKILL.md"), skillMd("user-mgmt"))

    const app = Server.App()
    const res = await app.request(`/skill-uninstall?directory=${encodeURIComponent(project.path)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "user-mgmt", location: path.join(globalDir, "SKILL.md") }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: "user-mgmt", deleted: true })
    expect(await fs.stat(globalDir).catch(() => undefined)).toBeUndefined()
    expect((await fs.stat(projectDir)).isDirectory()).toBe(true)
  })

  test("a skill installed in both project and global scope is listed twice with different locations", async () => {
    await using home = await tmpdir()
    await using project = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".merakcode", "skills", "tool-design")
        await fs.mkdir(skillDir, { recursive: true })
        await Filesystem.write(path.join(skillDir, "SKILL.md"), skillMd("Tool Design Agent"))
      },
    })

    process.env.MERAKCODE_TEST_HOME = home.path
    using _ = globalConfig(path.join(home.path, ".merakcode"))

    const globalDir = path.join(home.path, ".merakcode", "skills", "tool-design")
    await fs.mkdir(globalDir, { recursive: true })
    await Filesystem.write(path.join(globalDir, "SKILL.md"), skillMd("Tool Design Agent"))

    const app = Server.App()
    const res = await app.request(`/skill?directory=${encodeURIComponent(project.path)}`)
    expect(res.status).toBe(200)

    const rows = ((await res.json()) as { name: string; location: string; scope?: string }[]).filter((s) =>
      s.location.includes(`${path.sep}tool-design${path.sep}`),
    )
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.scope).sort()).toEqual(["global", "project"])
    expect(new Set(rows.map((r) => r.location)).size).toBe(2)
  })

  test("the backfill scan dedupes by location and still adds a project install when a global one exists", async () => {
    await using home = await tmpdir()
    await using project = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".merakcode", "skills", "tool-design")
        await fs.mkdir(skillDir, { recursive: true })
        await Filesystem.write(path.join(skillDir, "SKILL.md"), skillMd("shared-alias"))
      },
    })

    process.env.MERAKCODE_TEST_HOME = home.path
    process.env.MERAKCODE_DISABLE_PROJECT_CONFIG = "true"
    using _ = globalConfig(path.join(home.path, ".merakcode"))

    const globalDir = path.join(home.path, ".merakcode", "skills", "tool-design")
    await fs.mkdir(globalDir, { recursive: true })
    await Filesystem.write(path.join(globalDir, "SKILL.md"), skillMd("shared-alias"))

    const app = Server.App()
    const res = await app.request(`/skill?directory=${encodeURIComponent(project.path)}`)
    expect(res.status).toBe(200)

    const rows = ((await res.json()) as { name: string; location: string; scope?: string }[]).filter((s) =>
      s.location.includes(`${path.sep}tool-design${path.sep}`),
    )
    expect(rows).toHaveLength(2)

    const projectRow = rows.find((r) => r.scope === "project")
    expect(projectRow).toBeDefined()
    // The backfilled name is the marketplace directory name, not the frontmatter alias
    expect(projectRow!.name).toBe("tool-design")
  })
})
