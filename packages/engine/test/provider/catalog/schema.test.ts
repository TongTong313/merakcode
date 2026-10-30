import { afterAll, expect, test } from "vitest"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Provider } from "@merakcode/engine/agent/model/provider"
import { CatalogModel } from "../../../src/agent/model/catalog/model"
import * as DeepSeek from "../../../src/agent/model/catalog/deepseek"
import * as Alibaba from "../../../src/agent/model/catalog/alibaba"
import * as OpenRouter from "../../../src/agent/model/catalog/openrouter"
import * as Anthropic from "../../../src/agent/model/catalog/anthropic"
import * as OpenAI from "../../../src/agent/model/catalog/openai"
import * as Google from "../../../src/agent/model/catalog/google"
import * as Moonshot from "../../../src/agent/model/catalog/moonshot"
import * as Zhipu from "../../../src/agent/model/catalog/zhipu"
import { parseList as parseRelay } from "../../../src/agent/model/catalog/relay"
import { fromConfig } from "../../../src/agent/model/catalog/config"
import { tmpdir } from "../../fixture/fixture"
import { load, parseItems, restoreCatalog, writeCatalog } from "./fixture"

afterAll(restoreCatalog)

test("every provider's fixture parses into valid CatalogModel records", async () => {
  const openai = parseItems((await load("openai")).data, (item) => OpenAI.parse(item, new Set(["gpt-5-2"])))
  const google = parseItems((await load("google")).models, Google.parse)
  const moonshot = parseItems((await load("moonshot")).data, Moonshot.parse)
  const zhipu = parseItems((await load("zhipu")).data, Zhipu.parse)
  const all = [
    ...parseItems((await load("deepseek")).data, DeepSeek.parse),
    ...parseItems((await load("alibaba")).output.models, Alibaba.parse),
    ...parseItems((await load("openrouter")).data, OpenRouter.parse),
    ...parseItems((await load("anthropic")).data, Anthropic.parse),
    ...openai,
    ...google,
    ...moonshot,
    ...zhipu,
    ...parseRelay(await load("relay")),
    fromConfig("custom", { name: "Custom", reasoning: true, limit: { context: 8192 } }),
  ]
  for (const model of all) expect(CatalogModel.safeParse(model).success, model.id).toBe(true)
  expect(openai.map((model) => [model.id, model.status])).toEqual([
    ["gpt-5.2", undefined],
    ["model-id-2", "deprecated"],
  ])
  expect(google).toEqual([
    {
      id: "gemini-4-argon",
      name: "Gemini 4 Argon",
      context: 1048576,
      output: 943718,
      reasoning: true,
      temperature: true,
    },
  ])
  expect(moonshot[0]).toMatchObject({
    id: "kimi-k3",
    context: 1048576,
    input: ["text", "image", "video"],
    reasoning: true,
  })
  expect(zhipu).toEqual([{ id: "glm-5.3", name: "glm-5.3" }])
})

test("a relay station list parses into CatalogModel", async () => {
  const models = parseRelay(await load("relay"))
  expect(models[0]).toEqual({ id: "claude-private", name: "claude-private", endpoints: ["anthropic"] })
  expect(models[1]).toEqual({
    id: "gpt-local",
    name: "gpt-local",
    context: 32000,
    output: 4096,
    input: ["text", "image"],
    reasoning: false,
    toolcall: true,
    endpoints: ["openai"],
  })
})

test("a model defined in config goes through the same merge and overrides catalog values", async () => {
  await writeCatalog("deepseek", [{ id: "deepseek-v4-pro", context: 999, output: 111, reasoning: true }])
  await using tmp = await tmpdir({
    config: {
      provider: {
        deepseek: {
          models: { "deepseek-v4-pro": { limit: { context: 12345 } } },
          options: { apiKey: "test-key" },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const model = await Provider.getModel("deepseek", "deepseek-v4-pro")
      expect(model.limit).toEqual({ context: 12345, output: 111 })
      expect(model.capabilities.reasoning).toBe(true)
    },
  })
})
