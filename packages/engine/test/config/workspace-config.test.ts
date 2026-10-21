import { afterEach, describe, expect, test } from "vitest"
import fs from "fs/promises"
import path from "path"
import { Config } from "@merakcode/engine/config/config"
import { Instance } from "@merakcode/engine/project/instance"
import { Global } from "@merakcode/engine/global/index"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

Log.init({ print: false })

describe("Config workspace layer", () => {
  afterEach(async () => {
    await Instance.disposeAll().catch(() => undefined)
  })

  test("in multi-root, the workspace layer overrides global and yields to primary project config", async () => {
    await using a = await tmpdir({ git: true })
    await using b = await tmpdir({ git: true })
    const folders = [{ path: a.path }, { path: b.path }]

    // Open once to get the stable workspace id, then write the workspace layer and primary project config
    const id = await Instance.provide({
      directory: a.path,
      workspace: { folders },
      fn: async () => Instance.project.id,
    })
    await Instance.disposeAll()

    const wsDir = path.join(Global.Path.data, "workspace", id)
    await fs.mkdir(wsDir, { recursive: true })
    await Filesystem.write(
      path.join(wsDir, "merakcode.json"),
      JSON.stringify({
        default_agent: "from-workspace",
        model: "ws/model",
      }),
    )
    await Filesystem.write(
      path.join(a.path, "merakcode.json"),
      JSON.stringify({
        model: "primary/model",
      }),
    )

    await Instance.provide({
      directory: a.path,
      workspace: { folders },
      fn: async () => {
        const config = await Config.get()
        expect(config.default_agent).toBe("from-workspace")
        expect(config.model).toBe("primary/model")
      },
    })
  })

  test("in multi-root, updateProjectMerakCode writes to the workspace data directory, not the repo", async () => {
    await using a = await tmpdir({ git: true })
    await using b = await tmpdir({ git: true })
    await Instance.provide({
      directory: a.path,
      workspace: {
        folders: [{ path: a.path }, { path: b.path }],
      },
      fn: async () => {
        const id = Instance.project.id
        await Config.updateProjectMerakCode({ default_agent: "ws-write" })
        const wsFile = path.join(Global.Path.data, "workspace", id, "merakcode.json")
        expect(await Filesystem.isFile(wsFile)).toBe(true)
        const body = await Filesystem.readJson(wsFile)
        expect(body.default_agent).toBe("ws-write")
        expect(await Filesystem.isFile(path.join(a.path, "merakcode.json"))).toBe(false)
        expect(await Filesystem.isFile(path.join(a.path, ".merakcode", "merakcode.json"))).toBe(false)
        const config = await Config.get()
        expect(config.default_agent).toBe("ws-write")
      },
    })
  })

  test("single-root updateProjectMerakCode still writes to the project directory (CLI contract)", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Config.updateProjectMerakCode({ default_agent: "solo-write" })
        const projectFile = path.join(tmp.path, ".merakcode", "merakcode.json")
        expect(await Filesystem.isFile(projectFile)).toBe(true)
        const body = await Filesystem.readJson(projectFile)
        expect(body.default_agent).toBe("solo-write")
      },
    })
  })

  test("loads commands from additional roots but ignores their permission and model", async () => {
    await using a = await tmpdir({ git: true })
    await using b = await tmpdir({
      git: true,
      init: async (dir) => {
        const cmdDir = path.join(dir, ".merakcode", "command")
        await fs.mkdir(cmdDir, { recursive: true })
        await Filesystem.write(path.join(cmdDir, "from-secondary.md"), "# From Secondary\nSecondary command.")
        await Filesystem.write(
          path.join(dir, ".merakcode", "merakcode.json"),
          JSON.stringify({
            model: "secondary/should-not-win",
            permission: { bash: "deny" },
          }),
        )
      },
    })

    await Instance.provide({
      directory: a.path,
      workspace: {
        folders: [{ path: a.path }, { path: b.path }],
      },
      fn: async () => {
        const config = await Config.get()
        expect(config.command?.["from-secondary"]).toBeDefined()
        expect(config.model).not.toBe("secondary/should-not-win")
        expect(config.permission?.bash).not.toBe("deny")
      },
    })
  })
})
