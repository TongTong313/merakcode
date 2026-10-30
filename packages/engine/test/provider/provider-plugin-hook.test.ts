import { describe, expect, test } from "vitest"
import { Http } from "@merakcode/util/http"
import { pathToFileURL } from "url"
import path from "path"
import { Provider } from "@merakcode/engine/agent/model/provider"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"
import { Config } from "../../src/app/config/files/config"

/**
 * Wiring of the provider extension hooks in provider.ts.
 *
 * test/plugin/provider-hook.test.ts covers how `Plugin.customProviders()` / `Plugin.wrapProviderFetch()` aggregate
 * hooks. These tests prove provider.ts actually wires them into `Provider.list()` / `getModel()` / `getSDK()`: a
 * real plugin registers a working provider and `LanguageModelV2.doGenerate()` sends a real HTTP request to a fake
 * model server, so the hooks are not merely declared but called.
 */

async function writePlugin(dir: string, name: string, body: string) {
  const file = path.join(dir, `${name}.ts`)
  await Filesystem.write(file, body)
  return pathToFileURL(file).href
}

const model = {
  id: "h2-e2e-model",
  providerID: "h2-e2e-provider",
  name: "H2 E2E Model",
  api: { id: "h2-e2e-model", npm: "@ai-sdk/openai-compatible" },
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: false,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 4096, output: 4096 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2024-01-01",
}

describe("provider.ts wiring of provider extension hooks", () => {
  test("plugin providers resolve through Provider.list()/getModel() and calls reach the server via the wrapped fetch", async () => {
    await using tmp = await tmpdir({ git: true })
    const received: { path: string; body: unknown }[] = []
    const server = await Http.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        received.push({ path: new URL(request.url).pathname, body: await request.json() })
        return Response.json({
          id: "chatcmpl-h2-e2e",
          object: "chat.completion",
          created: 0,
          model: "h2-e2e-model",
          choices: [
            { index: 0, message: { role: "assistant", content: "来自假模型服务器的回复" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      },
    })
    try {
      const baseURL = `${server.url}v1`
      const pluginUrl = await writePlugin(
        tmp.path,
        "e2e-provider-plugin",
        `
        export default async function () {
          return {
            provider: {
              id: "h2-e2e-plugin",
              async providers() {
                return {
                  "h2-e2e-provider": {
                    id: "h2-e2e-provider",
                    name: "H2 E2E Provider",
                    source: "custom",
                    env: [],
                    options: { baseURL: ${JSON.stringify(baseURL)}, apiKey: "test-key" },
                    models: { "h2-e2e-model": ${JSON.stringify({ ...model, api: { ...model.api, url: baseURL } })} },
                  },
                }
              },
              async fetch(request, ctx) {
                globalThis.__h2E2EFetchCalls__ ??= []
                globalThis.__h2E2EFetchCalls__.push(ctx.providerID + "/" + ctx.modelID)
                return ctx.next(request)
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
      ;(globalThis as Record<string, unknown>).__h2E2EFetchCalls__ = []

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const providers = await Provider.list()
          expect(providers["h2-e2e-provider"]?.models["h2-e2e-model"]).toBeDefined()

          const resolved = await Provider.getModel("h2-e2e-provider", "h2-e2e-model")
          const language = await Provider.getLanguage(resolved)
          const result = await language.doGenerate({
            prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
            maxOutputTokens: 16,
          })

          const text = result.content.find((part) => part.type === "text")
          expect(text?.text).toBe("来自假模型服务器的回复")
        },
      })

      expect(received).toHaveLength(1)
      expect(received[0]?.path).toBe("/v1/chat/completions")
      // The plugin fetch hook ran once with this call's providerID/modelID.
      expect((globalThis as Record<string, unknown>).__h2E2EFetchCalls__).toEqual(["h2-e2e-provider/h2-e2e-model"])
    } finally {
      await server.stop(true)
    }
  })

  test("with a fetch hook registered, the provider's own options.fetch still receives (url, init{body, headers}) per the AI SDK contract", async () => {
    await using tmp = await tmpdir({ git: true })
    const server = await Http.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        return Response.json({
          id: "chatcmpl-h2-shape",
          object: "chat.completion",
          created: 0,
          model: "h2-e2e-model",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          echo: { auth: request.headers.get("authorization"), type: request.headers.get("content-type") },
        })
      },
    })
    try {
      const baseURL = `${server.url}v1`
      const pluginUrl = await writePlugin(
        tmp.path,
        "shape-provider-plugin",
        `
        export default async function () {
          return {
            provider: {
              id: "h2-shape-plugin",
              async providers() {
                return {
                  "h2-e2e-provider": {
                    id: "h2-e2e-provider",
                    name: "H2 Shape Provider",
                    source: "custom",
                    env: [],
                    options: {
                      baseURL: ${JSON.stringify(baseURL)},
                      apiKey: "test-key",
                      async fetch(input, init) {
                        globalThis.__h2BaseFetchSeen__ = {
                          input: typeof input,
                          model: JSON.parse(init.body).model,
                          contentType: init.headers["content-type"],
                          tls: init.tls,
                        }
                        const headers = new Headers(init.headers)
                        headers.set("Authorization", "Bearer signed")
                        return fetch(input, { ...init, headers })
                      },
                    },
                    models: { "h2-e2e-model": ${JSON.stringify({ ...model, api: { ...model.api, url: baseURL } })} },
                  },
                }
              },
              async fetch(request, ctx) {
                return ctx.next(request, { tls: { rejectUnauthorized: true } })
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
      ;(globalThis as Record<string, unknown>).__h2BaseFetchSeen__ = undefined

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const resolved = await Provider.getModel("h2-e2e-provider", "h2-e2e-model")
          const language = await Provider.getLanguage(resolved)
          const result = await language.doGenerate({
            prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
            maxOutputTokens: 16,
          })
          expect((result.response?.body as { echo?: unknown })?.echo).toEqual({
            auth: "Bearer signed",
            type: "application/json",
          })
        },
      })

      expect((globalThis as Record<string, unknown>).__h2BaseFetchSeen__).toEqual({
        input: "string",
        model: "h2-e2e-model",
        contentType: "application/json",
        tls: { rejectUnauthorized: true },
      })
    } finally {
      await server.stop(true)
    }
  })

  test("ids in disabled_providers stay out of Provider.list() even when a plugin registers them", async () => {
    await using tmp = await tmpdir({ git: true })
    const pluginUrl = await writePlugin(
      tmp.path,
      "disabled-provider-plugin",
      `
      export default async function () {
        return {
          provider: {
            id: "h2-disabled-plugin",
            async providers() {
              return {
                "h2-disabled-provider": {
                  id: "h2-disabled-provider",
                  name: "H2 Disabled Provider",
                  source: "custom",
                  env: [],
                  options: {},
                  models: {},
                },
              }
            },
          },
        }
      }
      `,
    )
    await Filesystem.write(
      path.join(tmp.path, "merakcode.json"),
      JSON.stringify({
        $schema: Config.SCHEMA,
        plugin: [pluginUrl],
        disabled_providers: ["h2-disabled-provider"],
      }),
    )

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const providers = await Provider.list()
        expect(providers["h2-disabled-provider"]).toBeUndefined()
      },
    })
  })
})

/**
 * `provider.models()` must match opencode 1.16.2 semantics so plugins ported from opencode behave the same:
 *
 * - For `models()`, `ProviderHook.id` is the target provider (opencode only passes `database[hook.id]`), so these
 *   plugins do not filter on `provider.id` themselves, just like opencode plugins;
 * - the return value replaces that provider's models wholesale rather than merging;
 * - the engine normalizes each model's `id` / `providerID` from its key.
 */
describe("provider.models() matches opencode 1.16.2 semantics", () => {
  test("replaces and normalizes models only for the provider matching hook.id; other providers and hooks are untouched", async () => {
    await using tmp = await tmpdir({ git: true })
    // The target plugin's hook.id is the provider it takes over; models() does no provider.id check.
    const targetPlugin = await writePlugin(
      tmp.path,
      "models-target-plugin",
      `
      export default async function () {
        return {
          provider: {
            id: "p1a-target-provider",
            async providers() {
              return {
                "p1a-target-provider": {
                  id: "p1a-target-provider",
                  name: "Target Provider",
                  source: "custom",
                  env: [],
                  options: {},
                  models: { "base-model": ${JSON.stringify(model)} },
                },
              }
            },
            async models(provider) {
              globalThis.__p1aTargetSeen__ ??= []
              globalThis.__p1aTargetSeen__.push(provider.id)
              // 键是 modelID；id/providerID 故意写成错的，验证引擎按键规范化
              return {
                "replaced-model": ${JSON.stringify({ ...model, id: "wrong-id", providerID: "wrong-provider", name: "插件给的模型" })},
              }
            },
          },
        }
      }
      `,
    )
    // The bystander plugin's hook.id matches no provider, so its models() must never be called.
    const bystanderPlugin = await writePlugin(
      tmp.path,
      "models-bystander-plugin",
      `
      export default async function () {
        return {
          provider: {
            id: "p1a-bystander-plugin",
            async providers() {
              return {
                "p1a-bystander-provider": {
                  id: "p1a-bystander-provider",
                  name: "Bystander Provider",
                  source: "custom",
                  env: [],
                  options: {},
                  models: { "untouched-model": ${JSON.stringify(model)} },
                },
              }
            },
            async models(provider) {
              globalThis.__p1aBystanderSeen__ ??= []
              globalThis.__p1aBystanderSeen__.push(provider.id)
              return { "leaked-model": ${JSON.stringify({ ...model, id: "leaked-model" })} }
            },
          },
        }
      }
      `,
    )
    await Filesystem.write(
      path.join(tmp.path, "merakcode.json"),
      JSON.stringify({
        $schema: Config.SCHEMA,
        plugin: [targetPlugin, bystanderPlugin],
      }),
    )
    ;(globalThis as Record<string, unknown>).__p1aTargetSeen__ = []
    ;(globalThis as Record<string, unknown>).__p1aBystanderSeen__ = []

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const providers = await Provider.list()

        // Wholesale replacement: the plugin's model is present and the original base-model is gone.
        const target = providers["p1a-target-provider"]
        expect(target).toBeDefined()
        expect(Object.keys(target!.models)).toEqual(["replaced-model"])
        expect(target!.models["replaced-model"]?.name).toBe("插件给的模型")

        // Normalization: id comes from the key and providerID from the target, fixing the plugin's wrong values.
        expect(target!.models["replaced-model"]?.id).toBe("replaced-model")
        expect(target!.models["replaced-model"]?.providerID).toBe("p1a-target-provider")
        // getModel has its own lookup and gating, so resolving here proves the models landed in the data it reads.
        expect((await Provider.getModel("p1a-target-provider", "replaced-model")).id).toBe("replaced-model")

        // models() runs only for the provider matching hook.id; the target never sees the bystander's provider.
        expect((globalThis as Record<string, unknown>).__p1aTargetSeen__).toEqual(["p1a-target-provider"])

        // The bystander's models() never runs, its provider keeps its models, and no provider is polluted by
        // leaked-model (which the old semantics added to every provider).
        expect((globalThis as Record<string, unknown>).__p1aBystanderSeen__).toEqual([])
        expect(Object.keys(providers["p1a-bystander-provider"]!.models)).toEqual(["untouched-model"])
        for (const [id, provider] of Object.entries(providers))
          expect(Object.keys(provider.models), `${id} 不应被插件模型污染`).not.toContain("leaked-model")
      },
    })
  })

  test("an empty models() result means no usable models, so the provider is not listed", async () => {
    await using tmp = await tmpdir({ git: true })
    const pluginUrl = await writePlugin(
      tmp.path,
      "models-empty-plugin",
      `
      export default async function () {
        return {
          provider: {
            id: "p1a-empty-provider",
            async providers() {
              return {
                "p1a-empty-provider": {
                  id: "p1a-empty-provider",
                  name: "Empty Provider",
                  source: "custom",
                  env: [],
                  options: {},
                  models: { "base-model": ${JSON.stringify(model)} },
                },
              }
            },
            // 例如未登录：插件认为这个 provider 此刻没有任何可用模型
            async models() {
              return {}
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

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await Provider.list().then((x) => x["p1a-empty-provider"])).toBeUndefined()
      },
    })
  })

  test("a reasoning model from a plugin provider gets thinking levels and a default", async () => {
    await using tmp = await tmpdir({ git: true })
    const reasoning = { ...model, capabilities: { ...model.capabilities, reasoning: true } }
    const pluginUrl = await writePlugin(
      tmp.path,
      "reasoning-provider-plugin",
      `
      export default async function () {
        return {
          provider: {
            id: "reasoning-plugin",
            async providers() {
              return {
                "reasoning-provider": {
                  id: "reasoning-provider",
                  name: "Reasoning Provider",
                  source: "custom",
                  env: [],
                  options: { apiKey: "test-key" },
                  models: { "h2-e2e-model": ${JSON.stringify({ ...reasoning, providerID: "reasoning-provider" })} },
                },
              }
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
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel("reasoning-provider", "h2-e2e-model")
        expect(Object.keys(resolved.variants ?? {})).toEqual(["off", "on"])
        expect(resolved.defaultVariant).toBe("on")
      },
    })
  })
})
