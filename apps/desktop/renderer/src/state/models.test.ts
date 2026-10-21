import { afterEach, expect, test } from "vitest"
import type { Config, ProviderListResponses } from "@merakcode/sdk/client"
import { setState } from "./store"
import { choice, modelKey, shownDefaultModel, shownSmallModel } from "./models"

type Providers = ProviderListResponses[200]

afterEach(() => {
  setState({ config: undefined, providers: undefined })
})

/** Two connected providers. Alibaba is first, so an empty config falls back to its default model. */
function connect() {
  const model = {
    release_date: "2026-01-01",
    attachment: false,
    reasoning: false,
    temperature: true,
    tool_call: true,
    options: {},
    limit: { context: 1000, output: 100 },
  }
  setState("providers", {
    all: [
      {
        id: "alibaba-cn",
        name: "Alibaba (China)",
        env: [],
        models: {
          "qwen3.5-flash": { ...model, id: "qwen3.5-flash", name: "Qwen3.5 Flash" },
          "qwen-old": { ...model, id: "qwen-old", name: "Qwen Old", status: "deprecated" },
        },
      },
      {
        id: "anthropic",
        name: "Anthropic",
        env: [],
        models: { claude: { ...model, id: "claude", name: "Claude" } },
      },
    ],
    connected: ["alibaba-cn", "anthropic"],
    default: { "alibaba-cn": "qwen3.5-flash", anthropic: "claude" },
  } as Providers)
}

test("the default model setting shows the configured model when that model is connected", () => {
  connect()
  setState("config", { model: "anthropic/claude" } as Config)
  expect(shownDefaultModel()).toBe("anthropic/claude")
})

test("the default model setting shows the first connected provider's default when none is configured", () => {
  connect()
  setState("config", {} as Config)
  expect(shownDefaultModel()).toBe("alibaba-cn/qwen3.5-flash")
})

test("the default model setting matches the model a new conversation uses", () => {
  connect()
  setState("config", { model: "anthropic/claude" } as Config)
  const model = choice(undefined, "/work").model
  expect(model && modelKey(model)).toBe(shownDefaultModel())
})

test("the default model setting drops a configured model that is no longer connected", () => {
  connect()
  setState("config", { model: "openai/gpt-5" } as Config)
  expect(shownDefaultModel()).toBe("alibaba-cn/qwen3.5-flash")
})

test("the small model setting shows the configured model when that model is connected", () => {
  connect()
  setState("config", { small_model: "alibaba-cn/qwen3.5-flash" } as Config)
  expect(shownSmallModel()).toBe("alibaba-cn/qwen3.5-flash")
})

test("the small model setting stays empty when nothing is configured", () => {
  connect()
  setState("config", {} as Config)
  expect(shownSmallModel()).toBeUndefined()
})

test("the small model setting stays empty when the configured model is not connected", () => {
  connect()
  setState("config", { small_model: "openai/gpt-5" } as Config)
  expect(shownSmallModel()).toBeUndefined()
})

test("the small model setting stays empty when the configured model is deprecated", () => {
  connect()
  setState("config", { small_model: "alibaba-cn/qwen-old" } as Config)
  expect(shownSmallModel()).toBeUndefined()
})
