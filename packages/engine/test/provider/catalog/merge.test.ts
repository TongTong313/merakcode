import { afterEach, expect, test } from "vitest"
import { Auth } from "@merakcode/engine/agent/model/credentials"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Provider } from "@merakcode/engine/agent/model/provider"
import { FALLBACK } from "../../../src/agent/model/catalog"
import * as Alibaba from "../../../src/agent/model/catalog/alibaba"
import * as Anthropic from "../../../src/agent/model/catalog/anthropic"
import * as DeepSeek from "../../../src/agent/model/catalog/deepseek"
import * as Moonshot from "../../../src/agent/model/catalog/moonshot"
import * as OpenRouter from "../../../src/agent/model/catalog/openrouter"
import type { CatalogModel } from "../../../src/agent/model/catalog/model"
import { tmpdir } from "../../fixture/fixture"
import { load, parseItems, restoreCatalog, writeCatalog } from "./fixture"

const real = {
  alibaba: parseItems((await load("alibaba")).output.models, Alibaba.parse),
  anthropic: parseItems((await load("anthropic")).data, Anthropic.parse),
  deepseek: parseItems((await load("deepseek")).data, DeepSeek.parse),
  moonshot: parseItems((await load("moonshot")).data, Moonshot.parse),
  public: parseItems((await load("openrouter")).data, OpenRouter.parse),
}

afterEach(restoreCatalog)

/** Caches the given lists, connects the provider and reads one model through the provider list. */
async function resolve(
  providerID: string,
  modelID: string,
  lists: {
    official: Array<Partial<CatalogModel> & { id: string }>
    public?: Array<Partial<CatalogModel> & { id: string }>
  },
) {
  await writeCatalog(providerID, lists.official)
  if (lists.public) await writeCatalog("public", lists.public)
  await using tmp = await tmpdir()
  try {
    return await Instance.provide({
      directory: tmp.path,
      init: () => Auth.set(providerID, { type: "api", key: "test-key" }),
      fn: () => Provider.getModel(providerID, modelID),
    })
  } finally {
    await Auth.remove(providerID)
  }
}

const levels = (model: Provider.Model) => Object.keys(model.variants ?? {})

test("an OpenAI model without a window takes it from the public catalog", async () => {
  const model = await resolve("openai", "gpt-5.2", {
    official: [{ id: "gpt-5.2" }],
    public: real.public,
  })
  expect(model.limit).toEqual({ context: 400000, output: 128000 })
  expect(levels(model)).toEqual(["off", "low", "medium", "high", "xhigh"])
  expect(model.defaultVariant).toBe("medium")
})

test("an official Anthropic model has no price, so no cost is shown", async () => {
  const model = await resolve("anthropic", "claude-opus-5-5", { official: real.anthropic, public: real.public })
  expect(model.cost).toBeUndefined()
})

test("official DeepSeek keeps its own levels instead of the gateway's xhigh", async () => {
  const model = await resolve("deepseek", "deepseek-v4-pro", { official: real.deepseek, public: real.public })
  expect(levels(model)).toEqual(["off", "low", "high", "max"])
  expect(model.defaultVariant).toBe("high")
})

test("official Kimi K3 has no off even though the gateway lists none", async () => {
  const model = await resolve("moonshotai-cn", "kimi-k3", { official: real.moonshot, public: real.public })
  expect(levels(model)).toEqual(["low", "high", "max"])
  expect(model.defaultVariant).toBe("max")
})

test("Opus 5.5 defaults to medium even though the gateway preselects high", async () => {
  const model = await resolve("anthropic", "claude-opus-5-5", { official: real.anthropic, public: real.public })
  expect(levels(model)).toEqual(["low", "medium", "high", "xhigh", "max"])
  expect(model.defaultVariant).toBe("medium")
})

test("Bailian Qwen3.8 defaults to xhigh from the fallback table", async () => {
  const model = await resolve("alibaba-cn", "qwen3.8-max", { official: real.alibaba })
  expect(levels(model)).toEqual(["off", "low", "medium", "xhigh"])
  expect(model.defaultVariant).toBe("xhigh")
  expect(model.cost).toMatchObject({ currency: "CNY", input: 12, output: 36 })
})

test("the same model on Bailian and on DeepSeek gets each channel's own levels", async () => {
  const bailian = await resolve("alibaba-cn", "deepseek-v4-pro", { official: real.alibaba })
  const deepseek = await resolve("deepseek", "deepseek-v4-pro", { official: real.deepseek })
  expect(levels(bailian)).toEqual(["off", "high", "max"])
  expect(levels(deepseek)).toEqual(["off", "low", "high", "max"])
})

test("an official provider does not take gateway levels listed under another vendor", async () => {
  const model = await resolve("alibaba-cn", "gpt-oss-120b", {
    official: [{ id: "gpt-oss-120b", reasoning: true }],
    public: [{ id: "openai/gpt-oss-120b", efforts: ["low", "medium", "high"], canDisable: false }],
  })
  expect(levels(model)).toEqual(["off", "on"])
})

test("a Claude model that offers xhigh also offers max", async () => {
  const model = await resolve("anthropic", "claude-sonnet-5-5", {
    official: [{ id: "claude-sonnet-5-5", reasoning: true }],
  })
  expect(levels(model)).toEqual(["off", "low", "medium", "high", "xhigh", "max"])
  expect(model.defaultVariant).toBe("high")
})

test("Claude Mythos Preview offers max but not xhigh", async () => {
  const model = await resolve("anthropic", "claude-mythos-preview", {
    official: [{ id: "claude-mythos-preview", reasoning: true }],
  })
  expect(levels(model)).toEqual(["off", "low", "medium", "high", "max"])
})

test("a Claude model without effort support gets no levels from the fallback table", async () => {
  const model = await resolve("anthropic", "claude-sonnet-4-20250514", {
    official: [{ id: "claude-sonnet-4-20250514", reasoning: true }],
  })
  expect(levels(model)).toEqual(["off", "on"])
})

test("GPT-5.5 offers the documented levels without minimal", async () => {
  const model = await resolve("openai", "gpt-5.5", { official: [{ id: "gpt-5.5", reasoning: true }] })
  expect(levels(model)).toEqual(["off", "low", "medium", "high", "xhigh"])
  expect(model.defaultVariant).toBe("medium")
  expect(model.capabilities.temperature).toBe(false)
})

test("another GPT-5 model takes levels from the public catalog, not from the fallback table", async () => {
  const model = await resolve("openai", "gpt-5-mini", {
    official: [{ id: "gpt-5-mini" }],
    public: [{ id: "openai/gpt-5-mini", reasoning: true }],
  })
  expect(levels(model)).toEqual(["off", "on"])
  expect(model.capabilities.temperature).toBe(false)
})

test("Gemini models that cannot turn thinking off have no off", async () => {
  const argon = await resolve("google", "gemini-4-argon", { official: [{ id: "gemini-4-argon", reasoning: true }] })
  const pro = await resolve("google", "gemini-2.5-pro", { official: [{ id: "gemini-2.5-pro", reasoning: true }] })
  const flash = await resolve("google", "gemini-2.5-flash", { official: [{ id: "gemini-2.5-flash", reasoning: true }] })
  expect(levels(argon)).toEqual(["low", "medium", "high"])
  expect(argon.defaultVariant).toBe("medium")
  expect(levels(pro)).toEqual([])
  expect(levels(flash)).toEqual(["off", "on"])
})

test("every fallback entry names an official source and a check date", () => {
  expect(FALLBACK.length).toBeGreaterThan(10)
  for (const entry of FALLBACK) {
    expect(entry.source.startsWith("https://")).toBe(true)
    expect(entry.checked).toBe("2026-10-25")
  }
})
