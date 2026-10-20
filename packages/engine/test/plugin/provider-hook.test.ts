import { describe, expect, test } from "vitest"
import { pathToFileURL } from "url"
import path from "path"
import { Plugin } from "@merakcode/engine/plugin/index"
import { Instance } from "@merakcode/engine/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"
import { Config } from "@merakcode/engine/config/config"

/**
 * Provider extension hooks.
 *
 * The aggregation functions are tested end to end with real plugin files loaded via `file://` (no npm install) and
 * without mocking the loader or the functions themselves, so load order, stacking across plugins and hook error
 * handling are verified for real.
 */

async function writePlugin(dir: string, name: string, body: string) {
  const file = path.join(dir, `${name}.ts`)
  await Filesystem.write(file, body)
  return pathToFileURL(file).href
}

/**
 * `provider.models()` is an opencode 1.16.2 key that adds or overrides models of an existing provider; plugins
 * migrated from opencode that use it must not be silently ignored. The wiring into `Provider.state()` is covered by
 * test/provider/provider-plugin-hook.test.ts.
 *
 * `customModels()` follows opencode 1.16.2:
 * - `ProviderHook.id` names the target provider and only plugins with a matching id are called (opencode passes only
 *   `database[hook.id]`, so migrated plugins don't check their input);
 * - `undefined` means no plugin owns the provider and the caller must keep the enumerated models;
 * - a returned object is the plugin's complete answer and the caller replaces the models with it.
 */
describe("Plugin.customModels() / hasProviderModels() (opencode provider.models hook)", () => {
  /**
   * Plugins are dynamically loaded .ts files that may return partial model fields. These tests cover selection, not
   * field completeness, so assertions cast expected shapes through this helper.
   */
  const stub = <T>(value: T) => value as never

  /** The hook is only called when the target provider id matches the plugin hook id */
  const target = (id: string) =>
    stub({
      id,
      name: "Test Provider",
      source: "config" as const,
      env: [],
      options: {},
      models: { existing: { id: "existing", name: "引擎枚举出的模型" } },
    })

  test("without models hooks, hasProviderModels is false and customModels is undefined", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await Plugin.hasProviderModels()).toBe(false)
        // undefined means "nobody owns it, keep the enumerated models"; {} would mean "this provider has no models"
        expect(await Plugin.customModels(target("p1a-none"), {})).toBeUndefined()
      },
    })
  })

  test("calls the hook only for a matching hook.id, passes provider and auth, and uses the result as is", async () => {
    await using tmp = await tmpdir({ git: true })
    const pluginUrl = await writePlugin(
      tmp.path,
      "models-hook-plugin",
      `
      export default async function () {
        return {
          provider: {
            id: "p1a-models-provider",
            async models(provider, ctx) {
              globalThis.__p1aSeen__ = { providerID: provider.id, models: Object.keys(provider.models), auth: ctx.auth }
              return { "plugin-model": { id: "plugin-model", name: "插件给的模型" } }
            },
          },
        }
      }
      `,
    )
    await Filesystem.write(
      path.join(tmp.path, "merakcode.json"),
      JSON.stringify({ $schema: Config.SCHEMA, plugin: [pluginUrl] }),
    )
    ;(globalThis as Record<string, unknown>).__p1aSeen__ = undefined

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await Plugin.hasProviderModels()).toBe(true)
        const next = await Plugin.customModels(target("p1a-models-provider"), {
          auth: stub({ type: "api", key: "k" }),
        })
        expect(next).toEqual(stub({ "plugin-model": { id: "plugin-model", name: "插件给的模型" } }))
        // The hook got the provider the engine enumerated, not an empty shell, and auth unchanged
        expect((globalThis as Record<string, unknown>).__p1aSeen__).toEqual({
          providerID: "p1a-models-provider",
          models: ["existing"],
          auth: { type: "api", key: "k" },
        })

        // A provider with a different id: the hook is not called and the result is undefined
        ;(globalThis as Record<string, unknown>).__p1aSeen__ = undefined
        expect(await Plugin.customModels(target("p1a-other-provider"), {})).toBeUndefined()
        expect((globalThis as Record<string, unknown>).__p1aSeen__).toBeUndefined()
      },
    })
  })

  test("with two plugins for one provider, the later answer replaces the earlier one without merging", async () => {
    await using tmp = await tmpdir({ git: true })
    // Both plugins claim p1a-shared-provider
    const first = await writePlugin(
      tmp.path,
      "models-a",
      `
      export default async function () {
        return {
          provider: {
            id: "p1a-shared-provider",
            async models() {
              return { shared: { id: "shared", name: "来自 a" }, "only-a": { id: "only-a", name: "a 独有" } }
            },
          },
        }
      }
      `,
    )
    const second = await writePlugin(
      tmp.path,
      "models-b",
      `
      export default async function () {
        return {
          provider: {
            id: "p1a-shared-provider",
            async models() {
              return { shared: { id: "shared", name: "来自 b" } }
            },
          },
        }
      }
      `,
    )
    await Filesystem.write(
      path.join(tmp.path, "merakcode.json"),
      JSON.stringify({ $schema: Config.SCHEMA, plugin: [first, second] }),
    )

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const next = await Plugin.customModels(target("p1a-shared-provider"), {})
        // Replaced, not merged: the model only plugin a returned is gone
        expect(next).toEqual(stub({ shared: { id: "shared", name: "来自 b" } }))
      },
    })
  })

  test("a throwing hook only degrades its plugin and the other plugin's models still apply (fail-open)", async () => {
    await using tmp = await tmpdir({ git: true })
    // Use the { id, server } module form: Plugin.statuses() takes the id from the module (a bare exported function
    // falls back to the file:// spec), and the assertion below looks up the plugin by id
    const boom = await writePlugin(
      tmp.path,
      "models-boom",
      `
      export default {
        id: "p1-7-models-boom",
        server: async () => ({
          provider: {
            id: "p1a-failopen-provider",
            async models() {
              throw new Error("p1a-models-boom")
            },
          },
        }),
      }
      `,
    )
    const ok = await writePlugin(
      tmp.path,
      "models-ok",
      `
      export default async function () {
        return {
          provider: {
            id: "p1a-failopen-provider",
            async models() {
              return { survivor: { id: "survivor", name: "没受影响" } }
            },
          },
        }
      }
      `,
    )
    await Filesystem.write(
      path.join(tmp.path, "merakcode.json"),
      JSON.stringify({ $schema: Config.SCHEMA, plugin: [boom, ok] }),
    )

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const next = await Plugin.customModels(target("p1a-failopen-provider"), {})
        expect(next).toEqual(stub({ survivor: { id: "survivor", name: "没受影响" } }))
        // degraded, not failed: the plugin loaded fine and only this hook call threw
        const statuses = await Plugin.statuses()
        expect(statuses.find((item) => item.id === "p1-7-models-boom")?.status).toBe("degraded")
      },
    })
  })
})
