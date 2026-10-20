import { afterEach, describe, expect, test } from "vitest"
import path from "path"
import fs from "fs/promises"
import { pathToFileURL } from "url"
import { Config } from "@merakcode/engine/config/config"
import { Plugin } from "@merakcode/engine/plugin/index"
import { Instance } from "@merakcode/engine/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

/**
 * Local plugin specs in inline config (MERAKCODE_CONFIG_CONTENT).
 *
 * A local plugin that loaded from file config used to be treated as an npm package when given inline, failing with
 * BunInstallFailedError. Inline absolute paths must behave like file config; inline relative paths have no base
 * directory, so they fail with a clear error instead of guessing from cwd.
 */

const previous = process.env.MERAKCODE_CONFIG_CONTENT
afterEach(() => {
  if (previous === undefined) delete process.env.MERAKCODE_CONFIG_CONTENT
  else process.env.MERAKCODE_CONFIG_CONTENT = previous
})

function inline(config: Record<string, unknown>) {
  process.env.MERAKCODE_CONFIG_CONTENT = JSON.stringify(config)
}

/** Fixture plugin with a fixed id so it can be found in the status list */
async function writeProbe(file: string, id = "inline-probe") {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Filesystem.write(file, `export default { id: "${id}", server: async () => ({}) }\n`)
  return file
}

/** Equivalent of the reported openwork-local-time.js plugin: registers a local_time tool */
async function writeLocalTime(file: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Filesystem.write(
    file,
    [
      "export default {",
      '  id: "local-time-probe",',
      "  server: async () => ({",
      '    tool: { local_time: { description: "local time", args: {}, execute: async () => "now" } },',
      "  }),",
      "}",
      "",
    ].join("\n"),
  )
  return file
}

async function status(id: string) {
  return (await Plugin.statuses()).filter((item) => item.id === id)
}

describe("local plugin specs in inline config", () => {
  // The same plugin x three valid spellings x file/inline source must all give the same result.
  // The directory name has Chinese characters and a space; on Windows, native uses backslashes and forward uses
  // forward slashes, both with a drive letter.
  const spellings = {
    native: (file: string) => file,
    forward: (file: string) => file.replaceAll("\\", "/"),
    "file URL": (file: string) => pathToFileURL(file).href,
  }
  for (const ext of ["mjs", "js"]) {
    for (const [spelling, spell] of Object.entries(spellings)) {
      for (const source of ["file", "inline"] as const) {
        test(`${source} config · ${spelling} · .${ext}: plugin is active and registers local_time`, async () => {
          await using tmp = await tmpdir({ git: true })
          const plugin = await writeLocalTime(path.join(tmp.path, "插件 目录", `openwork-local-time.${ext}`))
          const config = { plugin: [spell(plugin)] }
          if (source === "inline") inline(config)
          else await Filesystem.write(path.join(tmp.path, "merakcode.json"), JSON.stringify(config))
          await Instance.provide({
            directory: tmp.path,
            fn: async () => {
              const entries = await status("local-time-probe")
              expect(entries.map((entry) => entry.status)).toEqual(["active"])
              expect(entries[0]?.tools).toContain("local_time")
            },
          })
        })
      }
    }
  }

  test("inline [path, options] tuple resolves the spec and keeps options as-is", async () => {
    await using tmp = await tmpdir({ git: true })
    const probe = await writeProbe(path.join(tmp.path, "plugins", "probe-plugin.mjs"))
    inline({ plugin: [[probe, { region: "east", retries: 2 }]] })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        expect(config.plugin).toContainEqual([pathToFileURL(probe).href, { region: "east", retries: 2 }])
        expect((await status("inline-probe")).map((entry) => entry.status)).toEqual(["active"])
      },
    })
  })

  test("plugin listed in both file and inline config is registered once", async () => {
    await using tmp = await tmpdir({ git: true })
    const probe = await writeProbe(path.join(tmp.path, "plugins", "probe-plugin.mjs"))
    await Filesystem.write(path.join(tmp.path, "merakcode.json"), JSON.stringify({ plugin: [probe] }))
    inline({ plugin: [probe] })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // One entry per source counts as a duplicate, even if one of them failed
        const entries = (await Plugin.statuses()).filter((item) => item.spec.includes("probe-plugin"))
        expect(entries.map((entry) => [entry.id, entry.status])).toEqual([["inline-probe", "active"]])
      },
    })
  })

  test("missing local plugin file fails with a not-found error instead of an npm install", async () => {
    await using tmp = await tmpdir({ git: true })
    const missing = path.join(tmp.path, "plugins", "missing-plugin.mjs")
    inline({ plugin: [missing] })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const entry = (await Plugin.statuses()).find((item) => item.spec === missing)
        expect(entry?.status).toBe("failed")
        expect(entry?.error).toContain("本地插件不存在")
        expect(entry?.error).not.toContain("BunInstallFailedError")
      },
    })
  })

  test("directory package with a missing entry fails with an unresolved-entry error, not plugin-not-found", async () => {
    await using tmp = await tmpdir({ git: true })
    const pkg = path.join(tmp.path, "plugins", "broken-plugin")
    await fs.mkdir(pkg, { recursive: true })
    await Filesystem.write(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "broken-plugin", main: "dist/missing.js" }),
    )
    inline({ plugin: [pkg] })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const entry = (await Plugin.statuses()).find((item) => item.spec.includes("broken-plugin"))
        expect(entry?.status).toBe("failed")
        expect(entry?.error).toContain("本地插件入口无法解析")
      },
    })
  })

  test("inline relative path fails and suggests an absolute path or file URL", async () => {
    await using tmp = await tmpdir({ git: true })
    await writeProbe(path.join(tmp.path, "plugins", "probe-plugin.mjs"))
    const relative = "./plugins/probe-plugin.mjs"
    inline({ plugin: [relative] })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const entry = (await Plugin.statuses()).find((item) => item.spec === relative)
        expect(entry?.status).toBe("failed")
        expect(entry?.error).toContain("请改用绝对路径或 file URL")
        expect(entry?.error).not.toContain("BunInstallFailedError")
      },
    })
  })

  test("inline absolute path to a directory package loads its package.json entry", async () => {
    await using tmp = await tmpdir({ git: true })
    const pkg = path.join(tmp.path, "plugins", "dir-plugin")
    await writeProbe(path.join(pkg, "dist", "entry.js"), "inline-dir-probe")
    await Filesystem.write(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "dir-plugin", type: "module", main: "dist/entry.js" }),
    )
    inline({ plugin: [pkg] })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const entries = await status("inline-dir-probe")
        expect(entries.map((entry) => entry.status)).toEqual(["active"])
      },
    })
  })
})
