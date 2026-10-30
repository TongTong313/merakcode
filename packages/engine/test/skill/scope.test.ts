import { describe, expect, test } from "vitest"
import path from "path"
import fs from "fs/promises"
import { configDirScope } from "@merakcode/engine/agent/skill/scope"
import { Global } from "@merakcode/engine/infra/global/index"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { globalConfig, tmpdir } from "../fixture/fixture"

describe("configDirScope", () => {
  test("non-git worktree slash: the global root is global", async () => {
    await using project = await tmpdir()
    await Instance.provide({
      directory: project.path,
      fn: () => {
        expect(Instance.worktree).toBe("/")
        expect(configDirScope(Global.Path.config)).toBe("global")
      },
    })
  })

  test("non-git worktree slash: project .merakcode is project", async () => {
    await using project = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, ".merakcode"), { recursive: true })
      },
    })
    await Instance.provide({
      directory: project.path,
      fn: () => {
        expect(Instance.worktree).toBe("/")
        expect(configDirScope(path.join(project.path, ".merakcode"))).toBe("project")
      },
    })
  })

  test("home git worktree: the global root ~/.merakcode is global", async () => {
    await using home = await tmpdir({ git: true })
    const prevHome = process.env.MERAKCODE_TEST_HOME
    process.env.MERAKCODE_TEST_HOME = home.path

    const configDir = path.join(home.path, ".merakcode")
    await fs.mkdir(configDir, { recursive: true })
    using _ = globalConfig(configDir)

    try {
      await Instance.provide({
        directory: home.path,
        fn: () => {
          expect(configDirScope(configDir)).toBe("global")
        },
      })
    } finally {
      process.env.MERAKCODE_TEST_HOME = prevHome
    }
  })

  test("git project: project .merakcode is project", async () => {
    await using project = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, ".merakcode"), { recursive: true })
      },
    })

    await Instance.provide({
      directory: project.path,
      fn: () => {
        expect(configDirScope(path.join(project.path, ".merakcode"))).toBe("project")
      },
    })
  })
})
