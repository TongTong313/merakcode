import { afterEach, expect, test } from "vitest"
import { createComputed, createRoot } from "solid-js"
import type { AssistantMessage, Config, ProviderListResponses, UserMessage } from "@merakcode/sdk/client"
import { setState } from "./store"
import { choice, choose, modelKey, shownDefaultModel, shownSmallModel, usage } from "./models"

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
  } as unknown as Providers)
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

function user(id: string, sessionID: string, model: UserMessage["model"], variant?: string): UserMessage {
  return { id, sessionID, role: "user", time: { created: 1 }, agent: "build", model, variant }
}

function reply(id: string, sessionID: string, providerID: string, modelID: string, cost: number): AssistantMessage {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 2 },
    parentID: "user",
    modelID,
    providerID,
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost,
    tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

test("a model used for the first time in a conversation starts at its official default", () => {
  connect()
  setState("providers", "all", 1, "models", "claude", "defaultVariant", "medium")
  setState("config", { model: "anthropic/claude" } as Config)
  expect(choice("fresh", "/work").variant).toBe("medium")
})

test("switching back to a model restores that model's last sent level", () => {
  connect()
  setState("providers", "all", 0, "models", "qwen3.5-flash", "defaultVariant", "xhigh")
  setState("providers", "all", 1, "models", "claude", "defaultVariant", "medium")
  setState("sessions", "message", "restore", [
    user("u1", "restore", { providerID: "anthropic", modelID: "claude" }, "low"),
    user("u2", "restore", { providerID: "alibaba-cn", modelID: "qwen3.5-flash" }, "high"),
  ])
  choose("restore", "/work", { model: { providerID: "anthropic", modelID: "claude" } })
  expect(choice("restore", "/work").variant).toBe("low")
})

test("changing the level of one model does not affect another", () => {
  connect()
  setState("providers", "all", 0, "models", "qwen3.5-flash", "defaultVariant", "xhigh")
  setState("providers", "all", 1, "models", "claude", "defaultVariant", "medium")
  choose("split", "/work", { model: { providerID: "anthropic", modelID: "claude" }, variant: "low" })
  choose("split", "/work", { model: { providerID: "alibaba-cn", modelID: "qwen3.5-flash" } })
  expect(choice("split", "/work").variant).toBe("xhigh")
  choose("split", "/work", { model: { providerID: "anthropic", modelID: "claude" } })
  expect(choice("split", "/work").variant).toBe("low")
})

test("choosing the level that is already chosen does not notify anything that reads the choice", () => {
  connect()
  setState("providers", "all", 1, "models", "claude", "defaultVariant", "medium")
  setState("config", { model: "anthropic/claude" } as Config)
  createRoot((dispose) => {
    let runs = 0
    createComputed(() => {
      void choice("same", "/work").variant
      runs++
    })
    choose("same", "/work", { variant: "high" })
    const after = runs
    choose("same", "/work", { variant: "high" })
    choose("same", "/work", { model: { providerID: "anthropic", modelID: "claude" } })
    choose("same", "/work", { model: { providerID: "anthropic", modelID: "claude" } })
    expect(runs - after).toBeLessThanOrEqual(1)
    dispose()
  })
})

test("usage hides cost when the model has no price", () => {
  connect()
  setState("sessions", "message", "free", [reply("a1", "free", "anthropic", "claude", 9)])
  expect(usage("free")?.costs).toEqual({})
})

test("usage keeps yuan and dollars separate", () => {
  connect()
  setState("providers", "all", 0, "models", "qwen3.5-flash", "cost", {
    input: 1,
    output: 1,
    cache: { read: 0, write: 0 },
    currency: "CNY",
  })
  setState("providers", "all", 1, "models", "claude", "cost", {
    input: 1,
    output: 1,
    cache: { read: 0, write: 0 },
    currency: "USD",
  })
  setState("sessions", "message", "mixed", [
    reply("a1", "mixed", "alibaba-cn", "qwen3.5-flash", 2),
    reply("a2", "mixed", "anthropic", "claude", 3),
  ])
  expect(usage("mixed")?.costs).toEqual({ CNY: 2, USD: 3 })
})
