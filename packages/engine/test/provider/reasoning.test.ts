import { describe, expect, test } from "vitest"
import {
  TOGGLE_OFF,
  TOGGLE_ON,
  encodeVariantsFromReasoning,
  parseReasoning,
  type ReasoningOption,
} from "../../../../packages/engine/src/provider/reasoning"
import type { Provider } from "../../../../packages/engine/src/provider/provider"
import { ProviderTransform } from "../../../../packages/engine/src/provider/transform"

const mockModel = (overrides: Partial<Provider.Model> & { reasoning_options?: ReasoningOption[] }): Provider.Model =>
  ({
    id: "test-model",
    providerID: "test",
    name: "Test",
    api: { id: "test-model", url: "https://api.test.com", npm: "@ai-sdk/openai-compatible" },
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128000, output: 32000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2024-01-01",
    variants: {},
    ...overrides,
  }) as Provider.Model

describe("parseReasoning", () => {
  test("toggle + effort + budget_tokens", () => {
    const opts: ReasoningOption[] = [
      { type: "toggle" },
      { type: "effort", values: ["high", "max"] },
      { type: "budget_tokens", max: 81920 },
    ]
    expect(parseReasoning(opts)).toEqual({
      canToggle: true,
      effortValues: ["high", "max"],
      budget: { max: 81920 },
    })
  })

  test("empty array yields all false/null", () => {
    expect(parseReasoning([])).toEqual({ canToggle: false, effortValues: [], budget: null })
  })

  test("undefined yields all false/null", () => {
    expect(parseReasoning(undefined)).toEqual({ canToggle: false, effortValues: [], budget: null })
  })
})

describe("encodeVariantsFromReasoning — DashScope (alibaba-cn)", () => {
  test("budget_tokens yields off plus low/medium/high, sending enable_thinking and thinking_budget", () => {
    const model = mockModel({
      providerID: "alibaba-cn",
      id: "qwen-plus",
      reasoning_options: [{ type: "toggle" }, { type: "budget_tokens", max: 81920 }],
    })
    const v = encodeVariantsFromReasoning(model)
    expect(v[TOGGLE_OFF]).toEqual({ enable_thinking: false })
    expect(v.low).toEqual({ enable_thinking: true, thinking_budget: 20480 })
    expect(v.medium).toEqual({ enable_thinking: true, thinking_budget: 40960 })
    expect(v.high).toEqual({ enable_thinking: true, thinking_budget: 81920 })
    expect(v.low?.reasoningEffort).toBeUndefined()
  })

  test("DashScope ignores effort, so without a budget only the off/on toggle remains", () => {
    const model = mockModel({
      providerID: "alibaba-cn",
      id: "deepseek-v4-pro",
      reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["high", "max"] }],
    })
    expect(encodeVariantsFromReasoning(model)).toEqual({
      [TOGGLE_OFF]: { enable_thinking: false },
      [TOGGLE_ON]: { enable_thinking: true },
    })
  })

  test("empty reasoning_options yields {}", () => {
    const model = mockModel({ providerID: "alibaba-cn", id: "glm-5.2", reasoning_options: [] })
    expect(encodeVariantsFromReasoning(model)).toEqual({})
  })
})

describe("encodeVariantsFromReasoning — Zhipu / Moonshot toggle", () => {
  test("zhipuai: off/on via thinking.type with clear_thinking:false", () => {
    const model = mockModel({ providerID: "zhipuai", id: "glm-4.6", reasoning_options: [{ type: "toggle" }] })
    expect(encodeVariantsFromReasoning(model)).toEqual({
      [TOGGLE_OFF]: { thinking: { type: "disabled" } },
      [TOGGLE_ON]: { thinking: { type: "enabled", clear_thinking: false } },
    })
  })

  test("moonshotai-cn: off/on via thinking.type without clear_thinking", () => {
    const model = mockModel({ providerID: "moonshotai-cn", id: "kimi-k2.5", reasoning_options: [{ type: "toggle" }] })
    expect(encodeVariantsFromReasoning(model)).toEqual({
      [TOGGLE_OFF]: { thinking: { type: "disabled" } },
      [TOGGLE_ON]: { thinking: { type: "enabled" } },
    })
  })
})

describe("encodeVariantsFromReasoning — unsupported providers are left alone (no invalid params)", () => {
  test("non openai-compatible npm (kimi on anthropic) yields {}", () => {
    const model = mockModel({
      providerID: "moonshotai",
      id: "kimi-k2.5",
      api: { id: "kimi-k2.5", url: "https://api.anthropic.com", npm: "@ai-sdk/anthropic" },
      reasoning_options: [{ type: "toggle" }],
    })
    expect(encodeVariantsFromReasoning(model)).toEqual({})
  })

  test("openai-compatible gateway outside the supported set (siliconflow) yields {} since its format is unknown", () => {
    const model = mockModel({
      providerID: "siliconflow-cn",
      id: "deepseek-ai/DeepSeek-R1",
      reasoning_options: [{ type: "toggle" }, { type: "budget_tokens", max: 32768 }],
    })
    expect(encodeVariantsFromReasoning(model)).toEqual({})
  })
})

describe("ProviderTransform.variants source selection", () => {
  test("ignores reasoning_options when legacy variants exist (official OpenAI), keeping legacy behavior", () => {
    const model = mockModel({
      providerID: "openai",
      id: "gpt-5",
      api: { id: "gpt-5", url: "https://api.openai.com", npm: "@ai-sdk/openai" },
      reasoning_options: [{ type: "effort", values: ["high"] }],
    })
    const withRO = ProviderTransform.variants(model)
    const legacy = ProviderTransform.variants({ ...model, reasoning_options: undefined })
    expect(withRO).toEqual(legacy)
  })

  test("alibaba-cn non-blocklisted models (qwen) prefer data-driven variants and never send reasoningEffort", () => {
    const model = mockModel({
      providerID: "alibaba-cn",
      id: "qwen-plus",
      api: { id: "qwen-plus", url: "https://dashscope.aliyuncs.com", npm: "@ai-sdk/openai-compatible" },
      reasoning_options: [{ type: "toggle" }, { type: "budget_tokens", max: 81920 }],
    })
    const v = ProviderTransform.variants(model)
    expect(v.high).toEqual({ enable_thinking: true, thinking_budget: 81920 })
    expect(v.low?.reasoningEffort).toBeUndefined()
  })

  test("alibaba-cn with reasoning_options=[] yields {} instead of falling back to fake legacy effort", () => {
    const model = mockModel({
      providerID: "alibaba-cn",
      id: "qvq-max",
      api: { id: "qvq-max", url: "https://dashscope.aliyuncs.com", npm: "@ai-sdk/openai-compatible" },
      reasoning_options: [],
    })
    expect(ProviderTransform.variants(model)).toEqual({})
  })

  test("uses models.dev data only when legacy variants are empty (blocklisted glm on DashScope)", () => {
    const model = mockModel({
      providerID: "alibaba-cn",
      id: "glm-5.1",
      api: { id: "glm-5.1", url: "https://dashscope.aliyuncs.com", npm: "@ai-sdk/openai-compatible" },
      reasoning_options: [{ type: "toggle" }, { type: "budget_tokens", max: 131072 }],
    })
    const v = ProviderTransform.variants(model)
    expect(v.off).toEqual({ enable_thinking: false })
    expect(v.high).toEqual({ enable_thinking: true, thinking_budget: 131072 })
  })

  test("providerOptions wraps variant params under the providerID key", () => {
    const model = mockModel({ providerID: "alibaba-cn", id: "qwen-plus", reasoning_options: [] })
    const params = { enable_thinking: true, thinking_budget: 40960 }
    expect(ProviderTransform.providerOptions(model, params)).toEqual({ "alibaba-cn": params })
  })
})
