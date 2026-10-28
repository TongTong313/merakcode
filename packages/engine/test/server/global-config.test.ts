import { afterEach, beforeEach, describe, expect, test } from "vitest"
import path from "path"
import { unlink } from "fs/promises"
import { Global } from "@merakcode/engine/global/index"
import { Server } from "@merakcode/engine/server/server"
import { Config } from "@merakcode/engine/config/config"
import { Filesystem } from "@merakcode/util/filesystem"

/**
 * The global config PATCH route must work without an Instance context. /global routes are registered before
 * .use(Instance.provide), so calling Config.state.invalidate() or Command.state.invalidate() there throws
 * Context.NotFound("instance") and returns 500; Config.updateGlobal disposes instances itself.
 */

// Candidate global config files; updateGlobal uses the first that exists, or .jsonc by default
const globalConfigCandidates = ["merakcode.jsonc", "merakcode.json"].map((file) => path.join(Global.Path.config, file))

// Original content of each candidate (undefined if it did not exist)
let originalContents: Array<string | undefined> = []

beforeEach(async () => {
  // Back up the candidates so tests don't pollute the user's global config
  originalContents = await Promise.all(
    globalConfigCandidates.map((filepath) => Filesystem.readText(filepath).catch(() => undefined)),
  )
})

afterEach(async () => {
  // Restore files that existed and delete the ones that did not
  await Promise.all(
    globalConfigCandidates.map(async (filepath, index) => {
      const original = originalContents[index]
      if (original === undefined) {
        await unlink(filepath).catch(() => undefined)
      } else {
        await Filesystem.write(filepath, original)
      }
    }),
  )
})

describe("global config routes", () => {
  test("Config.updateGlobal ignores the removed safety section and writes permission", async () => {
    const filepath = path.join(Global.Path.config, "merakcode.jsonc")
    await Promise.all(globalConfigCandidates.map((candidate) => unlink(candidate).catch(() => undefined)))
    await Filesystem.write(
      filepath,
      `{
  "$schema": "${Config.SCHEMA}",
  // 旧版安全配置
  "safety": {
    "level": "medium",
    "whitelist": [
      "del"
    ]
  }
}`,
    )

    const updated = await Config.updateGlobal({ permission: { read: "ask" } }, { skipDispose: true })
    const text = await Filesystem.readText(filepath)

    expect(updated.permission?.read).toBe("ask")
    // safety is no longer part of the Info schema
    expect((updated as unknown as Record<string, unknown>).safety).toBeUndefined()
    // The old block stays in the file untouched and the patch is written alongside it
    expect(text).toContain('"level"')
    expect(text).toContain('"del"')
    expect(text).toContain('"read": "ask"')
  })

  test("Config.updateGlobal handles a merakcode.json with comments", async () => {
    const filepath = path.join(Global.Path.config, "merakcode.json")
    await Promise.all(globalConfigCandidates.map((candidate) => unlink(candidate).catch(() => undefined)))
    await Filesystem.write(
      filepath,
      `{
  "$schema": "${Config.SCHEMA}",
  "locale": "zh-CN", // merakcode.json 里也可能写了注释
  "plugin_options": {
    "example-plugin": { "feature": { "enabled": true } },
  },
}`,
    )

    const updated = await Config.updateGlobal(
      { plugin_options: { "example-plugin": { feature: { enabled: false } } } },
      { skipDispose: true },
    )
    const text = await Filesystem.readText(filepath)
    type Shape = { plugin_options?: { "example-plugin"?: { feature?: { enabled?: boolean } } } }
    const parsed = JSON.parse(text) as Shape
    const read = (c: Shape) => c.plugin_options?.["example-plugin"]?.feature?.enabled

    expect(read(updated as Shape)).toBe(false)
    expect(read(parsed)).toBe(false)
  })

  test("PATCH /global/config returns 200 without Instance.provide", async () => {
    const app = Server.App()

    type Shape = { plugin_options?: { "example-plugin"?: { feature?: { enabled?: boolean } } } }
    const read = (c: Shape) => c.plugin_options?.["example-plugin"]?.feature?.enabled
    const patch = (enabled: boolean) =>
      app.request("http://localhost/global/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plugin_options: { "example-plugin": { feature: { enabled } } } }),
      })

    const disableResponse = await patch(false)
    const disabled = await disableResponse.json()
    expect(disableResponse.status, JSON.stringify(disabled)).toBe(200)
    expect(read(disabled as Shape)).toBe(false)

    const enableResponse = await patch(true)
    const enabled = await enableResponse.json()
    expect(enableResponse.status, JSON.stringify(enabled)).toBe(200)
    expect(read(enabled as Shape)).toBe(true)
  })

  test("unknown top-level keys are stripped, and sibling keys in plugin_options survive a write", async () => {
    // Why plugin config must live under plugin_options:
    // 1. Config.Info uses .strip(), so unknown top-level keys are dropped while the route still returns 200.
    // 2. Writes go through patchJsonc, leaf by leaf, so sibling keys in the same namespace are not overwritten.
    const app = Server.App()
    const filepath = path.join(Global.Path.config, "merakcode.jsonc")
    await Promise.all(globalConfigCandidates.map((candidate) => unlink(candidate).catch(() => undefined)))
    await Filesystem.write(
      filepath,
      JSON.stringify({ plugin_options: { "example-plugin": { feature: { enabled: true }, other: { keep: 1 } } } }),
    )

    // A top-level payload returns 200 but changes nothing
    const legacy = await app.request("http://localhost/global/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feature: { enabled: false } }),
    })
    expect(legacy.status).toBe(200)
    expect(await legacy.json()).not.toHaveProperty("feature")
    type Shape = {
      plugin_options?: { "example-plugin"?: { feature?: { enabled?: boolean }; other?: { keep?: number } } }
    }
    const afterLegacy = JSON.parse(await Filesystem.readText(filepath)) as Shape
    expect(afterLegacy.plugin_options?.["example-plugin"]?.feature?.enabled).toBe(true)

    // A plugin_options payload is applied and keeps the sibling "other" key
    const current = await app.request("http://localhost/global/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plugin_options: { "example-plugin": { feature: { enabled: false } } } }),
    })
    expect(current.status).toBe(200)
    const written = JSON.parse(await Filesystem.readText(filepath)) as Shape
    expect(written.plugin_options?.["example-plugin"]?.feature?.enabled).toBe(false)
    expect(written.plugin_options?.["example-plugin"]?.other?.keep).toBe(1)
  })

  test("PATCH /global/config updates other global fields such as locale", async () => {
    const app = Server.App()

    const localeResponse = await app.request("http://localhost/global/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: "en-US" as const }),
    })

    expect(localeResponse.status).toBe(200)
    const localeJson = (await localeResponse.json()) as { locale?: string }
    expect(localeJson.locale).toBe("en-US")
  })
})
