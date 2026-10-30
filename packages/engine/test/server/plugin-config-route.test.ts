import { afterEach, describe, expect, test } from "vitest"
import path from "path"
import fs from "fs/promises"
import { fileURLToPath, pathToFileURL } from "url"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Server } from "@merakcode/engine/app/server/server"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll().catch(() => undefined)
})

describe("plugin.add / plugin.remove", () => {
  test("add keeps only the latest plugin per name in project config; remove works by name or spec", async () => {
    // Writing project config creates .merakcode; link zod first so the next config load installs nothing from npm
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, ".merakcode", "node_modules"), { recursive: true })
        await fs.symlink(
          path.dirname(fileURLToPath(import.meta.resolve("zod"))),
          path.join(dir, ".merakcode", "node_modules", "zod"),
          process.platform === "win32" ? "junction" : "dir",
        )
      },
    })
    // Local file plugins avoid npm downloads; the same file name counts as the same plugin
    const plugin = (dir: string, name: string) => pathToFileURL(path.join(tmp.path, dir, name + ".js")).href
    const [old, other, latest] = [plugin("v1", "demo"), plugin("v1", "other"), plugin("v2", "demo")]
    const app = Server.App()
    const query = `directory=${encodeURIComponent(tmp.path)}`
    const add = async (specifier: string) =>
      app.request(`/plugin?${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ specifier }),
      })
    const remove = async (name: string) =>
      (await app.request(`/plugin?${query}&name=${encodeURIComponent(name)}`, { method: "DELETE" })).json()
    const plugins = async () => {
      const config = (await (await app.request(`/config?${query}`)).json()) as { plugin?: string[] }
      return config.plugin ?? []
    }

    expect((await add(old)).status).toBe(200)
    await add(other)
    await add(latest)
    expect(await plugins()).toEqual([other, latest])

    expect(await remove("demo")).toBe(true)
    expect(await remove(other)).toBe(true)
    expect(await plugins()).toEqual([])
    expect(await remove("nope")).toBe(false)
  })
})
