import { afterEach, expect, test } from "vitest"
import fs from "fs/promises"
import path from "path"
import { Config } from "@merakcode/engine/app/config/files/config"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"
import { globalConfig, tmpdir } from "../fixture/fixture"

const originalHome = process.env.MERAKCODE_TEST_HOME

afterEach(() => {
  process.env.MERAKCODE_TEST_HOME = originalHome
})

/** Makes the directory string differ from the git worktree, which used to let the upward scan escape the repo root. */
function ideDirectory(dir: string) {
  const canonical = Filesystem.canonicalDirectory(dir)
  if (canonical !== dir) return canonical
  return `${canonical}${path.sep}.`
}

test("the upward scan stops at the git root: a .merakcode above a child git project is not loaded", async () => {
  await using home = await tmpdir({
    init: async (dir) => {
      const ghost = path.join(dir, ".merakcode")
      await fs.mkdir(ghost)
      await Filesystem.write(
        path.join(ghost, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          permission: { write: "allow", edit: "allow" },
        }),
      )
      const child = path.join(dir, "child")
      await fs.mkdir(child)
      await Process.run(["git", "init"], { cwd: child })
      await Process.run(["git", "config", "user.name", "MerakCode Test"], { cwd: child })
      await Process.run(["git", "config", "user.email", "merakcode-test@example.com"], { cwd: child })
      await Process.run(["git", "commit", "--allow-empty", "-m", "root"], { cwd: child })
      return child
    },
  })

  process.env.MERAKCODE_TEST_HOME = home.path

  await Instance.provide({
    directory: ideDirectory(home.extra),
    fn: async () => {
      const config = await Config.get()
      expect(config.permission?.write).not.toBe("allow")
      expect(config.permission?.edit).not.toBe("allow")
      const dirs = await Config.directories()
      expect(dirs.some((dir) => Filesystem.sameDirectory(dir, path.join(home.path, ".merakcode")))).toBe(false)
    },
  })
})

test("loads $HOME/.merakcode when home itself is the project", async () => {
  await using home = await tmpdir({
    git: true,
    init: async (dir) => {
      const ghost = path.join(dir, ".merakcode")
      await fs.mkdir(ghost)
      await Filesystem.write(
        path.join(ghost, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          permission: { write: "allow", edit: "allow" },
        }),
      )
    },
  })

  process.env.MERAKCODE_TEST_HOME = home.path

  await Instance.provide({
    directory: home.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.permission?.write).toBe("allow")
      expect(config.permission?.edit).toBe("allow")
    },
  })
})

test("ancestor .merakcode inside the repo is still merged into subdirectories", async () => {
  await using repo = await tmpdir({
    git: true,
    init: async (dir) => {
      const nested = path.join(dir, ".merakcode")
      await fs.mkdir(nested)
      await Filesystem.write(
        path.join(nested, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          permission: { write: "allow" },
        }),
      )
      const pkg = path.join(dir, "pkg")
      await fs.mkdir(pkg)
      return pkg
    },
  })

  await Instance.provide({
    directory: repo.extra,
    fn: async () => {
      const config = await Config.get()
      expect(config.permission?.write).toBe("allow")
    },
  })
})

test("home as a git repo: the global root reached by the upward scan stays global, once and below the project", async () => {
  await using home = await tmpdir({
    git: true,
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, ".merakcode", "merakcode.json"),
        JSON.stringify({ $schema: Config.SCHEMA, permission: { write: "deny", edit: "allow" } }),
      )
      const child = path.join(dir, "child")
      await Filesystem.write(
        path.join(child, "merakcode.json"),
        JSON.stringify({ $schema: Config.SCHEMA, permission: { write: "allow" } }),
      )
      return child
    },
  })

  process.env.MERAKCODE_TEST_HOME = home.path
  using _ = globalConfig(path.join(home.path, ".merakcode"))

  await Instance.provide({
    directory: home.extra,
    fn: async () => {
      expect(Filesystem.sameDirectory(Instance.worktree, home.path)).toBe(true)
      const config = await Config.get()
      expect(config.permission?.write).toBe("allow")
      expect(config.permission?.edit).toBe("allow")
      const dirs = await Config.directories()
      const root = path.join(home.path, ".merakcode")
      expect(dirs.filter((dir) => Filesystem.sameDirectory(dir, root))).toHaveLength(1)
    },
  })
})
