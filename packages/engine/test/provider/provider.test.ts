import { readFileSync } from "fs"
import { afterEach, expect, test } from "vitest"
import path from "path"

import { tmpdir } from "../fixture/fixture"
import { restoreCatalog, writeCatalog } from "./catalog/fixture"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Provider } from "@merakcode/engine/agent/model/provider"
import { Auth } from "@merakcode/engine/agent/model/credentials"
import { Filesystem } from "@merakcode/util/filesystem"
import { Config } from "@merakcode/engine/app/config/files/config"

afterEach(async () => {
  for (const id of ["anthropic", "openai", "alibaba-cn", "google", "openrouter"]) await Auth.remove(id)
})

test("provider loaded from a saved api key keeps loader options", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeDefined()
      // The saved key stays the connection source when a loader merges extra options.
      expect(providers["anthropic"].source).toBe("api")
      expect(providers["anthropic"].options.headers["anthropic-beta"]).toBeDefined()
    },
  })
})

test("provider loaded from config with apiKey option", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            anthropic: {
              options: {
                apiKey: "config-api-key",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeDefined()
    },
  })
})

test("disabled_providers excludes provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          disabled_providers: ["anthropic"],
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeUndefined()
    },
  })
})

test("enabled_providers restricts to only listed providers", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          enabled_providers: ["anthropic"],
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
      await Auth.set("openai", { type: "api", key: "test-openai-key" })
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeDefined()
      expect(providers["openai"]).toBeUndefined()
    },
  })
})

test("model whitelist filters models for provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            anthropic: {
              whitelist: ["claude-sonnet-4-20250514"],
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeDefined()
      const models = Object.keys(providers["anthropic"].models)
      expect(models).toContain("claude-sonnet-4-20250514")
      expect(models.length).toBe(1)
    },
  })
})

test("model blacklist excludes specific models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            anthropic: {
              blacklist: ["claude-sonnet-4-20250514"],
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeDefined()
      const models = Object.keys(providers["anthropic"].models)
      expect(models).not.toContain("claude-sonnet-4-20250514")
    },
  })
})

test("custom model alias via config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            anthropic: {
              models: {
                "my-alias": {
                  id: "claude-sonnet-4-20250514",
                  name: "My Custom Alias",
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeDefined()
      expect(providers["anthropic"].models["my-alias"]).toBeDefined()
      expect(providers["anthropic"].models["my-alias"].name).toBe("My Custom Alias")
    },
  })
})

test("custom provider with npm package", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            "custom-provider": {
              name: "Custom Provider",
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.custom.com/v1",
              env: ["CUSTOM_API_KEY"],
              models: {
                "custom-model": {
                  name: "Custom Model",
                  tool_call: true,
                  limit: {
                    context: 128000,
                    output: 4096,
                  },
                },
              },
              options: {
                apiKey: "custom-key",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["custom-provider"]).toBeDefined()
      expect(providers["custom-provider"].name).toBe("Custom Provider")
      expect(providers["custom-provider"].models["custom-model"]).toBeDefined()
    },
  })
})

test("saved api key connects a provider and config options are merged", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            anthropic: {
              options: {
                timeout: 60000,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "env-api-key" })
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeDefined()
      // Config options should be merged
      expect(providers["anthropic"].options.timeout).toBe(60000)
    },
  })
})

test("getModel returns model for valid provider/model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      const model = await Provider.getModel("anthropic", "claude-sonnet-4-20250514")
      expect(model).toBeDefined()
      expect(model.providerID).toBe("anthropic")
      expect(model.id).toBe("claude-sonnet-4-20250514")
      const language = await Provider.getLanguage(model)
      expect(language).toBeDefined()
    },
  })
})

test("getModel throws ModelNotFoundError for invalid model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      await expect(Provider.getModel("anthropic", "nonexistent-model")).rejects.toThrow()
    },
  })
})

test("getModel throws ModelNotFoundError for invalid provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(Provider.getModel("nonexistent-provider", "some-model")).rejects.toThrow()
    },
  })
})

test("parseModel correctly parses provider/model string", () => {
  const result = Provider.parseModel("anthropic/claude-sonnet-4")
  expect(result.providerID).toBe("anthropic")
  expect(result.modelID).toBe("claude-sonnet-4")
})

test("parseModel handles model IDs with slashes", () => {
  const result = Provider.parseModel("openrouter/anthropic/claude-3-opus")
  expect(result.providerID).toBe("openrouter")
  expect(result.modelID).toBe("anthropic/claude-3-opus")
})

test("defaultModel returns first available model when no config set", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      const model = await Provider.defaultModel()
      expect(model.providerID).toBeDefined()
      expect(model.modelID).toBeDefined()
    },
  })
})

// The out-of-the-box default model must support tool calls: a coding agent is useless on intent or speech models.
test("without a configured model, alibaba-cn picks the stable tool-calling alias qwen-plus, not a dated snapshot or a new model the account may lack", async () => {
  await using tmp = await tmpdir({
    init: (dir) =>
      Filesystem.write(path.join(dir, "merakcode.json"), JSON.stringify({ enabled_providers: ["alibaba-cn"] })),
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("alibaba-cn", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      expect(await Provider.defaultModel()).toEqual({ providerID: "alibaba-cn", modelID: "qwen-plus" })
    },
  })
})

test("defaultModel respects config model setting", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          model: "anthropic/claude-sonnet-4-20250514",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      const model = await Provider.defaultModel()
      expect(model.providerID).toBe("anthropic")
      expect(model.modelID).toBe("claude-sonnet-4-20250514")
    },
  })
})

test("provider with baseURL from config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            "custom-openai": {
              name: "Custom OpenAI",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "gpt-4": {
                  name: "GPT-4",
                  tool_call: true,
                  limit: { context: 128000, output: 4096 },
                },
              },
              options: {
                apiKey: "test-key",
                baseURL: "https://custom.openai.com/v1",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["custom-openai"]).toBeDefined()
      expect(providers["custom-openai"].options.baseURL).toBe("https://custom.openai.com/v1")
    },
  })
})

test("model cost defaults to zero when not specified", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            "test-provider": {
              name: "Test Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "test-model": {
                  name: "Test Model",
                  tool_call: true,
                  limit: { context: 128000, output: 4096 },
                },
              },
              options: {
                apiKey: "test-key",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["test-provider"].models["test-model"]
      expect(model.cost).toBeUndefined()
    },
  })
})

test("model options are merged from existing model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  options: {
                    customOption: "custom-value",
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["anthropic"].models["claude-sonnet-4-20250514"]
      expect(model.options.customOption).toBe("custom-value")
    },
  })
})

test("provider removed when all models filtered out", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            anthropic: {
              whitelist: ["nonexistent-model"],
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeUndefined()
    },
  })
})

test("closest finds model by partial match", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      const result = await Provider.closest("anthropic", ["sonnet-4"])
      expect(result).toBeDefined()
      expect(result?.providerID).toBe("anthropic")
      expect(result?.modelID).toContain("sonnet-4")
    },
  })
})

test("closest returns undefined for nonexistent provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await Provider.closest("nonexistent", ["model"])
      expect(result).toBeUndefined()
    },
  })
})

test("getModel uses realIdByKey for aliased models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            anthropic: {
              models: {
                "my-sonnet": {
                  id: "claude-sonnet-4-20250514",
                  name: "My Sonnet Alias",
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"].models["my-sonnet"]).toBeDefined()

      const model = await Provider.getModel("anthropic", "my-sonnet")
      expect(model).toBeDefined()
      expect(model.id).toBe("my-sonnet")
      expect(model.name).toBe("My Sonnet Alias")
    },
  })
})

test("provider api field sets model api.url", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            "custom-api": {
              name: "Custom API",
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.example.com/v1",
              env: [],
              models: {
                "model-1": {
                  name: "Model 1",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: {
                apiKey: "test-key",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      // api field is stored on model.api.url, used by getSDK to set baseURL
      expect(providers["custom-api"].models["model-1"].api.url).toBe("https://api.example.com/v1")
    },
  })
})

test("explicit baseURL overrides api field", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            "custom-api": {
              name: "Custom API",
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.example.com/v1",
              env: [],
              models: {
                "model-1": {
                  name: "Model 1",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: {
                apiKey: "test-key",
                baseURL: "https://custom.override.com/v1",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["custom-api"].options.baseURL).toBe("https://custom.override.com/v1")
    },
  })
})

test("model inherits properties from existing database model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  name: "Custom Name for Sonnet",
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["anthropic"].models["claude-sonnet-4-20250514"]
      expect(model.name).toBe("Custom Name for Sonnet")
      expect(model.capabilities.toolcall).toBe(true)
      expect(model.capabilities.attachment).toBe(true)
      expect(model.limit.context).toBeGreaterThan(0)
    },
  })
})

test("disabled_providers prevents loading even with env var", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          disabled_providers: ["openai"],
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("openai", { type: "api", key: "test-openai-key" })
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["openai"]).toBeUndefined()
    },
  })
})

test("enabled_providers with empty array allows no providers", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          enabled_providers: [],
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
      await Auth.set("openai", { type: "api", key: "test-openai-key" })
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(Object.keys(providers).length).toBe(0)
    },
  })
})

test("whitelist and blacklist can be combined", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            anthropic: {
              whitelist: ["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
              blacklist: ["claude-opus-4-20250514"],
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeDefined()
      const models = Object.keys(providers["anthropic"].models)
      expect(models).toContain("claude-sonnet-4-20250514")
      expect(models).not.toContain("claude-opus-4-20250514")
      expect(models.length).toBe(1)
    },
  })
})

test("model modalities default correctly", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            "test-provider": {
              name: "Test",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "test-model": {
                  name: "Test Model",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["test-provider"].models["test-model"]
      expect(model.capabilities.input.text).toBe(true)
      expect(model.capabilities.output.text).toBe(true)
    },
  })
})

test("model with custom cost values", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            "test-provider": {
              name: "Test",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "test-model": {
                  name: "Test Model",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                  cost: {
                    input: 5,
                    output: 15,
                    cache_read: 2.5,
                    cache_write: 7.5,
                  },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["test-provider"].models["test-model"]
      expect(model.cost?.input).toBe(5)
      expect(model.cost?.output).toBe(15)
      expect(model.cost?.cache.read).toBe(2.5)
      expect(model.cost?.cache.write).toBe(7.5)
    },
  })
})

test("getSmallModel returns appropriate small model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      const model = await Provider.getSmallModel("anthropic")
      expect(model).toBeDefined()
      expect(model?.id).toContain("haiku")
    },
  })
})

test("getSmallModel respects config small_model override", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          small_model: "anthropic/claude-sonnet-4-20250514",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      const model = await Provider.getSmallModel("anthropic")
      expect(model).toBeDefined()
      expect(model?.providerID).toBe("anthropic")
      expect(model?.id).toBe("claude-sonnet-4-20250514")
    },
  })
})

test("multiple providers can be configured simultaneously", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            anthropic: {
              options: { timeout: 30000 },
            },
            openai: {
              options: { timeout: 60000 },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-anthropic-key" })
      await Auth.set("openai", { type: "api", key: "test-openai-key" })
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"]).toBeDefined()
      expect(providers["openai"]).toBeDefined()
      expect(providers["anthropic"].options.timeout).toBe(30000)
      expect(providers["openai"].options.timeout).toBe(60000)
    },
  })
})

test("provider with custom npm package", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            "local-llm": {
              name: "Local LLM",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "llama-3": {
                  name: "Llama 3",
                  tool_call: true,
                  limit: { context: 8192, output: 2048 },
                },
              },
              options: {
                apiKey: "not-needed",
                baseURL: "http://localhost:11434/v1",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["local-llm"]).toBeDefined()
      expect(providers["local-llm"].models["llama-3"].api.npm).toBe("@ai-sdk/openai-compatible")
      expect(providers["local-llm"].options.baseURL).toBe("http://localhost:11434/v1")
    },
  })
})

// Edge cases for model configuration

test("model alias name defaults to alias key when id differs", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            anthropic: {
              models: {
                sonnet: {
                  id: "claude-sonnet-4-20250514",
                  // no name specified - should default to "sonnet" (the key)
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["anthropic"].models["sonnet"].name).toBe("sonnet")
    },
  })
})

test("environment variables named on a custom provider do not connect it", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            "single-env": {
              name: "Single Env Provider",
              npm: "@ai-sdk/openai-compatible",
              env: ["SINGLE_ENV_KEY"],
              models: {
                "model-1": {
                  name: "Model 1",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: {
                baseURL: "https://api.example.com/v1",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      process.env.SINGLE_ENV_KEY = "my-api-key"
    },
    fn: async () => {
      expect((await Provider.list())["single-env"]).toBeUndefined()
    },
  })
  delete process.env.SINGLE_ENV_KEY
})

test("model cost overrides existing cost values", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  cost: {
                    input: 999,
                    output: 888,
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["anthropic"].models["claude-sonnet-4-20250514"]
      expect(model.cost?.input).toBe(999)
      expect(model.cost?.output).toBe(888)
    },
  })
})

test("completely new provider not in database can be configured", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            "brand-new-provider": {
              name: "Brand New",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              api: "https://new-api.com/v1",
              models: {
                "new-model": {
                  name: "New Model",
                  tool_call: true,
                  reasoning: true,
                  attachment: true,
                  temperature: true,
                  limit: { context: 32000, output: 8000 },
                  modalities: {
                    input: ["text", "image"],
                    output: ["text"],
                  },
                },
              },
              options: {
                apiKey: "new-key",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["brand-new-provider"]).toBeDefined()
      expect(providers["brand-new-provider"].name).toBe("Brand New")
      const model = providers["brand-new-provider"].models["new-model"]
      expect(model.capabilities.reasoning).toBe(true)
      expect(model.capabilities.attachment).toBe(true)
      expect(model.capabilities.input.image).toBe(true)
    },
  })
})

test("disabled_providers and enabled_providers interaction", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          // enabled_providers takes precedence - only these are considered
          enabled_providers: ["anthropic", "openai"],
          // Then disabled_providers filters from the enabled set
          disabled_providers: ["openai"],
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-anthropic" })
      await Auth.set("openai", { type: "api", key: "test-openai" })
      await Auth.set("google", { type: "api", key: "test-google" })
    },
    fn: async () => {
      const providers = await Provider.list()
      // anthropic: in enabled, not in disabled = allowed
      expect(providers["anthropic"]).toBeDefined()
      // openai: in enabled, but also in disabled = NOT allowed
      expect(providers["openai"]).toBeUndefined()
      // google: not in enabled = NOT allowed (even though not disabled)
      expect(providers["google"]).toBeUndefined()
    },
  })
})

test("model with tool_call false", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            "no-tools": {
              name: "No Tools Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "basic-model": {
                  name: "Basic Model",
                  tool_call: false,
                  limit: { context: 4000, output: 1000 },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["no-tools"].models["basic-model"].capabilities.toolcall).toBe(false)
    },
  })
})

test("model defaults tool_call to true when not specified", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            "default-tools": {
              name: "Default Tools Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                model: {
                  name: "Model",
                  // tool_call not specified
                  limit: { context: 4000, output: 1000 },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["default-tools"].models["model"].capabilities.toolcall).toBe(true)
    },
  })
})

test("model headers are preserved", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            "headers-provider": {
              name: "Headers Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                model: {
                  name: "Model",
                  tool_call: true,
                  limit: { context: 4000, output: 1000 },
                  headers: {
                    "X-Custom-Header": "custom-value",
                    Authorization: "Bearer special-token",
                  },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["headers-provider"].models["model"]
      expect(model.headers).toEqual({
        "X-Custom-Header": "custom-value",
        Authorization: "Bearer special-token",
      })
    },
  })
})

test("getModel returns consistent results", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      const model1 = await Provider.getModel("anthropic", "claude-sonnet-4-20250514")
      const model2 = await Provider.getModel("anthropic", "claude-sonnet-4-20250514")
      expect(model1.providerID).toEqual(model2.providerID)
      expect(model1.id).toEqual(model2.id)
      expect(model1).toEqual(model2)
    },
  })
})

test("provider name defaults to id when not in database", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            "my-custom-id": {
              // no name specified
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                model: {
                  name: "Model",
                  tool_call: true,
                  limit: { context: 4000, output: 1000 },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["my-custom-id"].name).toBe("my-custom-id")
    },
  })
})

test("ModelNotFoundError includes suggestions for typos", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      try {
        await Provider.getModel("anthropic", "claude-sonet-4") // typo: sonet instead of sonnet
        expect(true).toBe(false) // Should not reach here
      } catch (e: any) {
        expect(e.data.suggestions).toBeDefined()
        expect(e.data.suggestions.length).toBeGreaterThan(0)
      }
    },
  })
})

test("ModelNotFoundError for provider includes suggestions", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      try {
        await Provider.getModel("antropic", "claude-sonnet-4") // typo: antropic
        expect(true).toBe(false) // Should not reach here
      } catch (e: any) {
        expect(e.data.suggestions).toBeDefined()
        expect(e.data.suggestions).toContain("anthropic")
      }
    },
  })
})

test("getProvider returns undefined for nonexistent provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const provider = await Provider.getProvider("nonexistent")
      expect(provider).toBeUndefined()
    },
  })
})

test("getProvider returns provider info", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      const provider = await Provider.getProvider("anthropic")
      expect(provider).toBeDefined()
      expect(provider?.id).toBe("anthropic")
    },
  })
})

test("closest returns undefined when no partial match found", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      const result = await Provider.closest("anthropic", ["nonexistent-xyz-model"])
      expect(result).toBeUndefined()
    },
  })
})

test("closest checks multiple query terms in order", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      // First term won't match, second will
      const result = await Provider.closest("anthropic", ["nonexistent", "haiku"])
      expect(result).toBeDefined()
      expect(result?.modelID).toContain("haiku")
    },
  })
})

test("model limit defaults to zero when not specified", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            "no-limit": {
              name: "No Limit Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                model: {
                  name: "Model",
                  tool_call: true,
                  // no limit specified
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["no-limit"].models["model"]
      expect(model.limit.context).toBe(0)
      expect(model.limit.output).toBe(0)
    },
  })
})

test("provider options are deeply merged", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            anthropic: {
              options: {
                headers: {
                  "X-Custom": "custom-value",
                },
                timeout: 30000,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      const providers = await Provider.list()
      // Custom options should be merged
      expect(providers["anthropic"].options.timeout).toBe(30000)
      expect(providers["anthropic"].options.headers["X-Custom"]).toBe("custom-value")
      // anthropic custom loader adds its own headers, they should coexist
      expect(providers["anthropic"].options.headers["anthropic-beta"]).toBeDefined()
    },
  })
})

test("custom model inherits the npm package from the official provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            openai: {
              models: {
                "my-custom-model": {
                  name: "My Custom Model",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("openai", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["openai"].models["my-custom-model"]
      expect(model).toBeDefined()
      expect(model.api.npm).toBe("@ai-sdk/openai")
    },
  })
})

test("custom model inherits the api url from the official provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            openrouter: {
              models: {
                "prime-intellect/intellect-3": {},
                "deepseek/deepseek-r1-0528": {
                  name: "DeepSeek R1",
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("openrouter", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers["openrouter"]).toBeDefined()

      // New model not in database should inherit api.url from provider
      const intellect = providers["openrouter"].models["prime-intellect/intellect-3"]
      expect(intellect).toBeDefined()
      expect(intellect.api.url).toBe("https://openrouter.ai/api/v1")

      // Another new model should also inherit api.url
      const deepseek = providers["openrouter"].models["deepseek/deepseek-r1-0528"]
      expect(deepseek).toBeDefined()
      expect(deepseek.api.url).toBe("https://openrouter.ai/api/v1")
      expect(deepseek.name).toBe("DeepSeek R1")
    },
  })
})

test("model variants are generated for reasoning models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      const providers = await Provider.list()
      // Claude sonnet 4 has reasoning capability
      const model = providers["anthropic"].models["claude-sonnet-4-20250514"]
      expect(model.capabilities.reasoning).toBe(true)
      expect(model.variants).toBeDefined()
      expect(Object.keys(model.variants!).length).toBeGreaterThan(0)
    },
  })
})

test("model variants can be disabled via config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            anthropic: {
              models: {
                "claude-opus-4-5": {
                  variants: {
                    high: { disabled: true },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["anthropic"].models["claude-opus-4-5"]
      expect(model.variants).toBeDefined()
      expect(model.variants!["high"]).toBeUndefined()
      expect(model.variants!["medium"]).toBeDefined()
    },
  })
})

test("model variants can be customized via config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  variants: {
                    high: {
                      thinking: {
                        type: "enabled",
                        budgetTokens: 20000,
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["anthropic"].models["claude-sonnet-4-20250514"]
      expect(model.variants!["high"]).toBeDefined()
      expect(model.variants!["high"].thinking.budgetTokens).toBe(20000)
    },
  })
})

test("disabled key is stripped from variant config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            anthropic: {
              models: {
                "claude-sonnet-4-20250514": {
                  variants: {
                    max: {
                      disabled: false,
                      customField: "test",
                    },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["anthropic"].models["claude-sonnet-4-20250514"]
      expect(model.variants!["max"]).toBeDefined()
      expect(model.variants!["max"].disabled).toBeUndefined()
      expect(model.variants!["max"].customField).toBe("test")
    },
  })
})

test("disabling the default level in config moves the default to a level that is still offered", async () => {
  await using tmp = await tmpdir({
    config: {
      provider: {
        deepseek: {
          options: { apiKey: "test-key" },
          models: {
            "deepseek-v4-pro": { reasoning: true, variants: { high: { disabled: true } } },
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const model = await Provider.getModel("deepseek", "deepseek-v4-pro")
      expect(Object.keys(model.variants ?? {})).toEqual(["off", "low", "max"])
      expect(model.defaultVariant).toBe("max")
    },
  })
})

test("all variants can be disabled via config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            anthropic: {
              models: {
                "claude-opus-4-5": {
                  variants: {
                    off: { disabled: true },
                    low: { disabled: true },
                    medium: { disabled: true },
                    high: { disabled: true },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["anthropic"].models["claude-opus-4-5"]
      expect(model.variants).toBeDefined()
      expect(Object.keys(model.variants!).length).toBe(0)
      expect(model.defaultVariant).toBeUndefined()
    },
  })
})

test("variant config merges with generated variants", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            anthropic: {
              models: {
                "claude-opus-4-5": {
                  variants: {
                    high: {
                      extraOption: "custom-value",
                    },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["anthropic"].models["claude-opus-4-5"]
      expect(model.variants!["high"]).toBeDefined()
      expect(model.variants!["high"].effort).toBe("high")
      expect(model.variants!["high"].extraOption).toBe("custom-value")
    },
  })
})

test("custom model with variants enabled and disabled", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            "custom-reasoning": {
              name: "Custom Reasoning Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "reasoning-model": {
                  name: "Reasoning Model",
                  tool_call: true,
                  reasoning: true,
                  limit: { context: 128000, output: 16000 },
                  variants: {
                    low: { reasoningEffort: "low" },
                    medium: { reasoningEffort: "medium" },
                    high: { reasoningEffort: "high", disabled: true },
                    custom: { reasoningEffort: "custom", budgetTokens: 5000 },
                  },
                },
              },
              options: { apiKey: "test-key" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      const model = providers["custom-reasoning"].models["reasoning-model"]
      expect(model.variants).toBeDefined()
      // Enabled variants should exist
      expect(model.variants!["low"]).toBeDefined()
      expect(model.variants!["low"].reasoningEffort).toBe("low")
      expect(model.variants!["medium"]).toBeDefined()
      expect(model.variants!["medium"].reasoningEffort).toBe("medium")
      expect(model.variants!["custom"]).toBeDefined()
      expect(model.variants!["custom"].reasoningEffort).toBe("custom")
      expect(model.variants!["custom"].budgetTokens).toBe(5000)
      // Disabled variant should not exist
      expect(model.variants!["high"]).toBeUndefined()
      // disabled key should be stripped from all variants
      expect(model.variants!["low"].disabled).toBeUndefined()
      expect(model.variants!["medium"].disabled).toBeUndefined()
      expect(model.variants!["custom"].disabled).toBeUndefined()
    },
  })
})

test("providers that share a display name stay separate", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            anthropic: { name: "Same Name" },
            relay: {
              name: "Same Name",
              npm: "@ai-sdk/anthropic",
              options: { apiKey: "relay-key" },
              models: { "relay-only": { name: "Relay Only" } },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await Auth.set("anthropic", { type: "api", key: "test-api-key" })
    },
    fn: async () => {
      const providers = await Provider.list()
      expect(providers.anthropic?.name).toBe("Same Name")
      expect(providers.relay?.name).toBe("Same Name")
      expect(providers.anthropic?.origin).toBe("official")
      expect(providers.relay?.origin).toBe("configured")
      expect(providers.relay?.models["relay-only"]).toBeDefined()
      expect(providers.anthropic?.models["relay-only"]).toBeUndefined()
    },
  })
})

test("an official homepage opens the named lines, and an unsuffixed id beats a versioned one", async () => {
  await writeCatalog("anthropic", [
    { id: "claude-opus-4-7" },
    { id: "claude-opus-5-5" },
    { id: "claude-opus-5-5-20251101" },
    { id: "claude-sonnet-4-5" },
    { id: "claude-sonnet-5-5" },
    { id: "claude-fable-5-1" },
    { id: "claude-haiku-5-5" },
  ])
  await writeCatalog("openai", [
    { id: "gpt-6-astra" },
    { id: "gpt-6.1-sol" },
    { id: "gpt-5.6-sol" },
    { id: "gpt-5.6-terra" },
    { id: "gpt-5.6-luna" },
    { id: "gpt-5.2" },
  ])
  await writeCatalog("alibaba-cn", [
    { id: "qwen-plus" },
    { id: "qwen-max" },
    { id: "qwen3-max" },
    { id: "qwen3.8-max" },
    { id: "qwen-plus-2025-12-01" },
    { id: "qwen-vl-max" },
  ])
  await writeCatalog("moonshotai-cn", [
    { id: "kimi-k3.1-pro" },
    { id: "kimi-k3-pro" },
    { id: "kimi-k3.1-pro-highspeed" },
    { id: "kimi-k2.5" },
  ])
  await writeCatalog("deepseek", [
    { id: "deepseek-flash" },
    { id: "deepseek-v4-flash" },
    { id: "deepseek-v4-pro" },
    { id: "deepseek-chat" },
  ])
  await writeCatalog("zhipuai", [
    { id: "glm-5.3" },
    { id: "glm-5.2" },
    { id: "glm-5.3-flash" },
    { id: "glm-4.7-flash" },
    { id: "glm-5.3-flashx" },
  ])
  await writeCatalog("google", [
    { id: "gemini-3.8-flash" },
    { id: "gemini-3.1-pro-preview" },
    { id: "gemini-3.5-flash-lite" },
    { id: "gemini-2.5-flash" },
  ])
  await writeCatalog("openrouter", [{ id: "openai/gpt-6-astra" }])
  try {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "merakcode.json"), JSON.stringify({ $schema: Config.SCHEMA }))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        for (const id of [
          "anthropic",
          "openai",
          "alibaba-cn",
          "moonshotai-cn",
          "deepseek",
          "zhipuai",
          "google",
          "openrouter",
        ])
          await Auth.set(id, { type: "api", key: `test-${id}` })
      },
      fn: async () => {
        const on = async (id: string) =>
          Object.entries((await Provider.list())[id].models)
            .filter(([, model]) => model.homepage)
            .map(([modelID]) => modelID)
            .toSorted()
        expect(await on("anthropic")).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"])
        expect(await on("openai")).toEqual(["gpt-6-astra", "gpt-6.1-sol"])
        expect(await on("alibaba-cn")).toEqual(["qwen-max", "qwen-plus"])
        expect(await on("moonshotai-cn")).toEqual(["kimi-k3.1-pro"])
        expect(await on("deepseek")).toEqual(["deepseek-flash", "deepseek-v4-pro"])
        expect(await on("zhipuai")).toEqual(["glm-5.3", "glm-5.3-flash"])
        expect(await on("google")).toEqual(["gemini-3.1-pro-preview", "gemini-3.8-flash"])
        expect(await on("openrouter")).toEqual([])

        await writeCatalog("alibaba-cn", [{ id: "qwen-plus" }, { id: "qwen3.8-max" }])
        Provider.invalidate()
        expect(await on("alibaba-cn")).toEqual(["qwen-plus"])
      },
    })
  } finally {
    await restoreCatalog()
    await Auth.remove("deepseek")
    await Auth.remove("moonshotai-cn")
    await Auth.remove("zhipuai")
  }
})

test("an official provider keeps only the newest model of each line on the homepage", async () => {
  await writeCatalog("anthropic", [
    { id: "claude-opus-4-7" },
    { id: "claude-opus-5-5" },
    { id: "claude-opus-5-5-20251101" },
    { id: "claude-sonnet-5-5" },
    { id: "claude-sonnet-4-5" },
    { id: "tts-1" },
    { id: "claude-haiku-5-5", toolcall: false },
  ])
  await writeCatalog("openai", [
    { id: "gpt-5.6-sol" },
    { id: "gpt-5.6-terra" },
    { id: "gpt-5.6-luna" },
    { id: "gpt-5.4-mini" },
    { id: "gpt-5-mini" },
    { id: "gpt-image-1" },
  ])
  try {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "merakcode.json"), JSON.stringify({ $schema: Config.SCHEMA }))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await Auth.set("anthropic", { type: "api", key: "test-api-key" })
        await Auth.set("openai", { type: "api", key: "test-openai-key" })
      },
      fn: async () => {
        const shown = async (id: string) =>
          Object.fromEntries(
            Object.entries((await Provider.list())[id].models).map(([modelID, model]) => [modelID, model.homepage]),
          )
        expect(await shown("anthropic")).toEqual({
          "claude-opus-4-7": false,
          "claude-opus-5-5": true,
          "claude-opus-5-5-20251101": false,
          "claude-sonnet-5-5": true,
          "claude-sonnet-4-5": false,
          "tts-1": false,
          "claude-haiku-5-5": false,
        })
        expect(await shown("openai")).toEqual({
          "gpt-5.6-sol": true,
          "gpt-5.6-terra": false,
          "gpt-5.6-luna": false,
          "gpt-5.4-mini": false,
          "gpt-5-mini": false,
          "gpt-image-1": false,
        })

        await writeCatalog("openai", [
          { id: "gpt-5.6-sol" },
          { id: "gpt-5.6-terra" },
          { id: "gpt-5.6-luna" },
          { id: "gpt-5.4-mini" },
          { id: "gpt-5-mini" },
          { id: "gpt-image-1" },
          { id: "gpt-6-sol" },
        ])
        Provider.invalidate()
        const next = await shown("openai")
        expect(next["gpt-6-sol"]).toBe(true)
        expect(next["gpt-5.6-sol"]).toBe(false)
        expect(next["gpt-5.6-terra"]).toBe(false)
      },
    })
  } finally {
    await restoreCatalog()
  }
})

test("a configured provider shows every model until the user turns one off", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          provider: {
            relay: {
              name: "Relay",
              npm: "@ai-sdk/openai-compatible",
              options: { apiKey: "relay-key" },
              models: {
                "qwen-plus": { name: "Qwen Plus" },
                "qwen-plus-2025-12-01": { name: "Qwen Plus Snapshot" },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const flags = () => {
        const models = Provider.list().then((providers) => providers.relay.models)
        return models.then((models) =>
          Object.fromEntries(Object.entries(models).map(([id, model]) => [id, model.homepage])),
        )
      }
      expect(await flags()).toEqual({ "qwen-plus": true, "qwen-plus-2025-12-01": true })

      await Config.updateProjectMerakCode({
        provider: { relay: { picker: { exclude: ["qwen-plus-2025-12-01"] } } },
      })
      Provider.invalidate()
      expect(await flags()).toEqual({ "qwen-plus": true, "qwen-plus-2025-12-01": false })

      await Config.updateProjectMerakCode({
        provider: { relay: { picker: { exclude: [] } } },
      })
      Provider.invalidate()
      expect(await flags()).toEqual({ "qwen-plus": true, "qwen-plus-2025-12-01": true })

      await Config.updateProjectMerakCode({
        provider: {
          relay: {
            models: { "qwen-max": { name: "Qwen Max" } },
          },
        },
      })
      Provider.invalidate()
      expect((await flags())["qwen-max"]).toBe(true)
    },
  })
})

test("include and exclude move an official model on or off the homepage", async () => {
  await writeCatalog("anthropic", [{ id: "claude-opus-5-5" }, { id: "claude-opus-5-5-20251101" }])
  try {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(
          path.join(dir, "merakcode.json"),
          JSON.stringify({
            $schema: Config.SCHEMA,
            provider: {
              anthropic: {
                picker: {
                  exclude: ["claude-opus-5-5"],
                  include: ["claude-opus-5-5-20251101"],
                },
              },
            },
          }),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await Auth.set("anthropic", { type: "api", key: "test-api-key" })
      },
      fn: async () => {
        const models = (await Provider.list()).anthropic.models
        expect(models["claude-opus-5-5"].homepage).toBe(false)
        expect(models["claude-opus-5-5-20251101"].homepage).toBe(true)
      },
    })
  } finally {
    await restoreCatalog()
  }
})

test("a short date after the version stays on the same line as the current id", async () => {
  await writeCatalog("moonshotai-cn", [{ id: "kimi-k3.1-pro-0905" }, { id: "kimi-k3.1-pro" }])
  await writeCatalog("google", [{ id: "gemini-2.5-flash" }, { id: "gemini-2.5-flash-preview-05-20" }])
  try {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "merakcode.json"), JSON.stringify({ $schema: Config.SCHEMA }))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await Auth.set("moonshotai-cn", { type: "api", key: "test-moonshot-key" })
        await Auth.set("google", { type: "api", key: "test-google-key" })
      },
      fn: async () => {
        const home = async (providerID: string, modelID: string) =>
          (await Provider.list())[providerID].models[modelID].homepage
        expect(await home("moonshotai-cn", "kimi-k3.1-pro")).toBe(true)
        expect(await home("moonshotai-cn", "kimi-k3.1-pro-0905")).toBe(false)
        expect(await home("google", "gemini-2.5-flash")).toBe(true)
        expect(await home("google", "gemini-2.5-flash-preview-05-20")).toBe(false)
      },
    })
  } finally {
    await restoreCatalog()
    await Auth.remove("moonshotai-cn")
  }
})

test("a vision letter stays off the plain model line", async () => {
  await writeCatalog("zhipuai", [{ id: "glm-4.6v" }, { id: "glm-4.5v" }, { id: "glm-4.7" }])
  try {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "merakcode.json"), JSON.stringify({ $schema: Config.SCHEMA }))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await Auth.set("zhipuai", { type: "api", key: "test-zhipu-key" })
      },
      fn: async () => {
        const models = (await Provider.list()).zhipuai.models
        expect(models["glm-4.6v"].homepage).toBe(false)
        expect(models["glm-4.5v"].homepage).toBe(false)
        expect(models["glm-4.7"].homepage).toBe(true)
      },
    })
  } finally {
    await restoreCatalog()
    await Auth.remove("zhipuai")
  }
})

test("a sized open-weight id stays off the homepage", async () => {
  await writeCatalog("alibaba-cn", [{ id: "qwen3-14b" }, { id: "qwen2-5-72b-instruct" }, { id: "qwen-plus" }])
  try {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "merakcode.json"), JSON.stringify({ $schema: Config.SCHEMA }))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await Auth.set("alibaba-cn", { type: "api", key: "test-alibaba-key" })
      },
      fn: async () => {
        const models = (await Provider.list())["alibaba-cn"].models
        expect(models["qwen3-14b"].homepage).toBe(false)
        expect(models["qwen2-5-72b-instruct"].homepage).toBe(false)
        expect(models["qwen-plus"].homepage).toBe(true)
      },
    })
  } finally {
    await restoreCatalog()
  }
})

test("a hosted catalog only defaults to its own model families", async () => {
  await writeCatalog("alibaba-cn", [{ id: "deepseek-v3" }, { id: "moonshot-kimi-k2-instruct" }, { id: "qwen-plus" }])
  await writeCatalog("openrouter", [{ id: "google/gemini-3-pro" }, { id: "openai/gpt-5.2" }])
  try {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "merakcode.json"), JSON.stringify({ $schema: Config.SCHEMA }))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await Auth.set("alibaba-cn", { type: "api", key: "test-alibaba-key" })
        await Auth.set("openrouter", { type: "api", key: "test-openrouter-key" })
      },
      fn: async () => {
        const alibaba = (await Provider.list())["alibaba-cn"].models
        expect(alibaba["deepseek-v3"].homepage).toBe(false)
        expect(alibaba["moonshot-kimi-k2-instruct"].homepage).toBe(false)
        expect(alibaba["qwen-plus"].homepage).toBe(true)
        const routed = await Provider.list()
        expect(routed.openrouter.models["google/gemini-3-pro"].homepage).toBe(false)
        expect(routed.openrouter.models["openai/gpt-5.2"].homepage).toBe(false)
      },
    })
  } finally {
    await restoreCatalog()
  }
})

test("speech, embedding, realtime and image models stay off the homepage", async () => {
  await writeCatalog("openai", [
    { id: "tts-1" },
    { id: "text-embedding-3-small" },
    { id: "gpt-realtime" },
    { id: "gpt-image-1" },
    { id: "gpt-6-sol" },
  ])
  try {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "merakcode.json"), JSON.stringify({ $schema: Config.SCHEMA }))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await Auth.set("openai", { type: "api", key: "test-openai-key" })
      },
      fn: async () => {
        const models = (await Provider.list()).openai.models
        expect(models["tts-1"].homepage).toBe(false)
        expect(models["text-embedding-3-small"].homepage).toBe(false)
        expect(models["gpt-realtime"].homepage).toBe(false)
        expect(models["gpt-image-1"].homepage).toBe(false)
        expect(models["gpt-6-sol"].homepage).toBe(true)
      },
    })
  } finally {
    await restoreCatalog()
  }
})

const SEEDED_HOMEPAGE: Record<string, string[]> = {
  "alibaba-cn": ["qwen-max", "qwen-plus"],
  anthropic: ["claude-opus-4-5", "claude-sonnet-4-5"],
  deepseek: [],
  google: ["gemini-3-flash-preview", "gemini-3-pro-preview"],
  "moonshotai-cn": [],
  openai: [],
  openrouter: [],
  zhipuai: ["glm-4.7", "glm-4.7-flash"],
}

test("a seeded catalog defaults to the current model of each live line", async () => {
  for (const [name] of Object.entries(SEEDED_HOMEPAGE)) {
    const seed = JSON.parse(readFileSync(new URL(`./catalog/seed/${name}.json`, import.meta.url), "utf8")) as {
      models: Array<{ id: string }>
    }
    await writeCatalog(name, seed.models)
  }
  try {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "merakcode.json"), JSON.stringify({ $schema: Config.SCHEMA }))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        for (const name of Object.keys(SEEDED_HOMEPAGE)) await Auth.set(name, { type: "api", key: `test-${name}` })
      },
      fn: async () => {
        const listed = await Provider.list()
        for (const [name, expected] of Object.entries(SEEDED_HOMEPAGE)) {
          const on = Object.entries(listed[name].models)
            .filter(([, model]) => model.homepage)
            .map(([id]) => id)
            .toSorted()
          expect(on, name).toEqual(expected)
        }
      },
    })
  } finally {
    await restoreCatalog()
    await Auth.remove("deepseek")
    await Auth.remove("moonshotai-cn")
    await Auth.remove("zhipuai")
  }
})
