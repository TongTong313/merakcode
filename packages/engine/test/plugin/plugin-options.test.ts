import { describe, expect, test } from "vitest"
import { pathToFileURL } from "url"
import path from "path"
import { Plugin } from "@merakcode/engine/plugin/index"
import { Config } from "@merakcode/engine/config/config"
import { Instance } from "@merakcode/engine/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

/**
 * The plugin_options config namespace. Real plugin files loaded via file:// verify how PluginInput.options is merged,
 * without mocking the plugin loader.
 */

async function writePlugin(dir: string, name: string, body: string) {
  const file = path.join(dir, `${name}.ts`)
  await Filesystem.write(file, body)
  return pathToFileURL(file).href
}

describe("Config.plugin_options → PluginInput.options", () => {
  test("Config.Info accepts plugin_options and keeps it instead of stripping it", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: { plugin_options: { "some-plugin": { token: "abc" } } },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        expect(config.plugin_options).toEqual({ "some-plugin": { token: "abc" } })
      },
    })
  })

  test("input.options is an empty object without config.plugin_options or module options", async () => {
    await using tmp = await tmpdir({ git: true })
    ;(globalThis as Record<string, unknown>).__h6Options__ = undefined
    const pluginUrl = await writePlugin(
      tmp.path,
      "bare-plugin",
      `
      export default async function (input) {
        globalThis.__h6Options__ = input.options
        return {}
      }
      `,
    )
    await Filesystem.write(
      path.join(tmp.path, "merakcode.json"),
      JSON.stringify({ $schema: Config.SCHEMA, plugin: [pluginUrl] }),
    )

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Plugin.list()
        expect((globalThis as Record<string, unknown>).__h6Options__).toEqual({})
      },
    })
  })

  test("a module exporting { id, server, options } gets its defaults when plugin_options is not set", async () => {
    await using tmp = await tmpdir({ git: true })
    ;(globalThis as Record<string, unknown>).__h6Options__ = undefined
    const pluginUrl = await writePlugin(
      tmp.path,
      "module-default-plugin",
      `
      export default {
        id: "h6-module-default-plugin",
        options: { endpoint: "https://module-default.example.com", retries: 1 },
        server: async (input) => {
          globalThis.__h6Options__ = input.options
          return {}
        },
      }
      `,
    )
    await Filesystem.write(
      path.join(tmp.path, "merakcode.json"),
      JSON.stringify({ $schema: Config.SCHEMA, plugin: [pluginUrl] }),
    )

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Plugin.list()
        expect((globalThis as Record<string, unknown>).__h6Options__).toEqual({
          endpoint: "https://module-default.example.com",
          retries: 1,
        })
      },
    })
  })

  test("config.plugin_options[id] is merged over module defaults key by key", async () => {
    await using tmp = await tmpdir({ git: true })
    ;(globalThis as Record<string, unknown>).__h6Options__ = undefined
    const pluginUrl = await writePlugin(
      tmp.path,
      "merged-options-plugin",
      `
      export default {
        id: "h6-merged-options-plugin",
        options: { endpoint: "https://module-default.example.com", retries: 1 },
        server: async (input) => {
          globalThis.__h6Options__ = input.options
          return {}
        },
      }
      `,
    )
    await Filesystem.write(
      path.join(tmp.path, "merakcode.json"),
      JSON.stringify({
        $schema: Config.SCHEMA,
        plugin: [pluginUrl],
        plugin_options: { "h6-merged-options-plugin": { endpoint: "https://user-configured.example.com" } },
      }),
    )

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Plugin.list()
        // endpoint comes from the user config; retries keeps the module default
        expect((globalThis as Record<string, unknown>).__h6Options__).toEqual({
          endpoint: "https://user-configured.example.com",
          retries: 1,
        })
      },
    })
  })

  test("two plugins each get only their own options", async () => {
    await using tmp = await tmpdir({ git: true })
    ;(globalThis as Record<string, unknown>).__h6OptionsA__ = undefined
    ;(globalThis as Record<string, unknown>).__h6OptionsB__ = undefined
    const pluginA = await writePlugin(
      tmp.path,
      "plugin-a",
      `
      export default {
        id: "h6-plugin-a",
        server: async (input) => {
          globalThis.__h6OptionsA__ = input.options
          return {}
        },
      }
      `,
    )
    const pluginB = await writePlugin(
      tmp.path,
      "plugin-b",
      `
      export default {
        id: "h6-plugin-b",
        server: async (input) => {
          globalThis.__h6OptionsB__ = input.options
          return {}
        },
      }
      `,
    )
    await Filesystem.write(
      path.join(tmp.path, "merakcode.json"),
      JSON.stringify({
        $schema: Config.SCHEMA,
        plugin: [pluginA, pluginB],
        plugin_options: {
          "h6-plugin-a": { role: "a" },
          "h6-plugin-b": { role: "b" },
        },
      }),
    )

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Plugin.list()
        expect((globalThis as Record<string, unknown>).__h6OptionsA__).toEqual({ role: "a" })
        expect((globalThis as Record<string, unknown>).__h6OptionsB__).toEqual({ role: "b" })
      },
    })
  })
})

/**
 * `config.plugin` accepts opencode 1.16.2 `[name, options]` tuples. Configs written for opencode contain them, and
 * accepting only strings would make zod reject the whole config, not just that entry. Tuple options are passed as the
 * second argument of `server(input, options)` and merged into `PluginInput.options`.
 */
describe("config.plugin [name, options] tuples (opencode format)", () => {
  test("tuple options reach both input.options and the second server argument", async () => {
    await using tmp = await tmpdir({ git: true })
    ;(globalThis as Record<string, unknown>).__tupleInput__ = undefined
    ;(globalThis as Record<string, unknown>).__tupleSecond__ = undefined
    const pluginUrl = await writePlugin(
      tmp.path,
      "tuple-plugin",
      `
      export default async function (input, options) {
        globalThis.__tupleInput__ = input.options
        globalThis.__tupleSecond__ = options
        return {}
      }
      `,
    )
    await Filesystem.write(
      path.join(tmp.path, "merakcode.json"),
      JSON.stringify({
        $schema: Config.SCHEMA,
        plugin: [[pluginUrl, { endpoint: "https://tuple.example.com", retries: 2 }]],
      }),
    )

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        // zod accepted the config and kept the tuple shape (resolvePlugins only resolves the spec)
        expect(Array.isArray(config.plugin?.[0])).toBe(true)

        await Plugin.list()
        const expected = { endpoint: "https://tuple.example.com", retries: 2 }
        expect((globalThis as Record<string, unknown>).__tupleInput__).toEqual(expected)
        expect((globalThis as Record<string, unknown>).__tupleSecond__).toEqual(expected)
      },
    })
  })

  test("config.plugin_options overrides tuple options for the same key", async () => {
    await using tmp = await tmpdir({ git: true })
    ;(globalThis as Record<string, unknown>).__tupleInput__ = undefined
    const pluginUrl = await writePlugin(
      tmp.path,
      "tuple-priority-plugin",
      `
      export default {
        id: "tuple-priority-plugin",
        server: async (input) => {
          globalThis.__tupleInput__ = input.options
          return {}
        },
      }
      `,
    )
    await Filesystem.write(
      path.join(tmp.path, "merakcode.json"),
      JSON.stringify({
        $schema: Config.SCHEMA,
        plugin: [[pluginUrl, { endpoint: "https://from-tuple.example.com", keep: "tuple" }]],
        plugin_options: { "tuple-priority-plugin": { endpoint: "https://from-options.example.com" } },
      }),
    )

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Plugin.list()
        expect((globalThis as Record<string, unknown>).__tupleInput__).toEqual({
          endpoint: "https://from-options.example.com",
          keep: "tuple",
        })
      },
    })
  })
})
