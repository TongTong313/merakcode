import { expect, test } from "vitest"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Auth } from "@merakcode/engine/auth/index"
import { Env } from "@merakcode/engine/env/index"
import { Instance } from "@merakcode/engine/project/instance"
import { Provider } from "@merakcode/engine/provider/provider"
import { Filesystem } from "@merakcode/util/filesystem"

test("the catalog exposed to clients lists only the official providers", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const catalog = await Provider.getFilteredProviders()
      expect(Object.keys(catalog).sort()).toEqual([
        "alibaba-cn",
        "anthropic",
        "deepseek",
        "google",
        "moonshotai-cn",
        "openai",
        "openrouter",
        "zhipuai",
      ])
    },
  })
})

test("a saved api key connects an official provider and an environment variable does not", async () => {
  await using tmp = await tmpdir()
  await Auth.remove("anthropic")
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("ANTHROPIC_API_KEY", "env-key")
    },
    fn: async () => {
      expect((await Provider.list())["anthropic"]).toBeUndefined()
      await Auth.set("anthropic", { type: "api", key: "saved-key" })
      Provider.invalidate()
      const connected = await Provider.list()
      expect(connected["anthropic"]?.source).toBe("api")
      expect(connected["anthropic"]?.key).toBe("saved-key")
    },
  })
  await Auth.remove("anthropic")
})

test("a custom provider lists only the models written in config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          provider: {
            groq: {
              name: "Groq",
              npm: "@ai-sdk/openai-compatible",
              models: { "llama-3": { name: "Llama 3" } },
              options: { apiKey: "groq-key", baseURL: "https://api.groq.com/openai/v1" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.set("GROQ_API_KEY", "env-key")
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(Object.keys(providers)).toEqual(["groq"])
      expect(Object.keys(providers["groq"].models)).toEqual(["llama-3"])
      expect(providers["groq"].key).toBeUndefined()
      expect(providers["groq"].options.apiKey).toBe("groq-key")
    },
  })

  await using named = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(path.join(dir, "merakcode.json"), JSON.stringify({ enabled_providers: ["groq"] }))
    },
  })
  await Instance.provide({
    directory: named.path,
    init: async () => {
      Env.set("GROQ_API_KEY", "env-key")
    },
    fn: async () => {
      expect(await Provider.list()).toEqual({})
    },
  })
})
