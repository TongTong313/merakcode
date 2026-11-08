import { afterEach, expect, test } from "vitest"
import type { CatalogModel } from "@merakcode/sdk"
import { setState } from "./store"
import { available, choice, choose, modelKey, shownDefaultModel } from "./models"

const model: CatalogModel = {
  provider: "relay",
  id: "first",
  window: 128000,
  maxOutput: 16000,
  source: "builtin",
  thinking: ["off", "high"],
  caps: { tools: true, vision: false, pdf: false },
  price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

function configure() {
  setState("models", [model, { ...model, id: "second", thinking: ["low", "high"] }])
  setState("config", { providers: { relay: { name: "Relay", hasKey: true } }, model: "relay/first" })
}

afterEach(() => {
  setState({ models: [], config: undefined, sessions: [] })
})

test("the default setting and a new conversation use the same configured model", () => {
  configure()
  expect(shownDefaultModel()).toBe("relay/first")
  expect(modelKey(choice(undefined, "/new-default").model!)).toBe("relay/first")
  setState("config", "providers", "relay", "disabled", true)
  expect(shownDefaultModel()).toBeUndefined()
  expect(available()).toEqual([])
})

test("model visibility survives configuration refresh without disabling the provider", () => {
  configure()
  setState("config", "providers", "relay", "picker", { exclude: ["second"] })
  expect(available().find((entry) => entry.model.id === "second")?.model.homepage).toBe(false)
  expect(available()).toHaveLength(2)
})

test("switching model does not inherit a different model's thinking level", () => {
  configure()
  setState("sessions", [
    {
      id: "thinking-session",
      createdAt: "2026-11-08T00:00:00Z",
      config: { workdir: "/work", provider: "relay", model: "first", thinking: "high" },
    },
  ])
  expect(choice("thinking-session", "/work").variant).toBe("high")
  choose("thinking-session", "/work", { model: { providerID: "relay", modelID: "second" } })
  expect(choice("thinking-session", "/work").variant).toBe("low")
  choose("thinking-session", "/work", { variant: "high" })
  choose("thinking-session", "/work", { model: { providerID: "relay", modelID: "first" } })
  expect(choice("thinking-session", "/work").variant).toBe("high")
  choose("thinking-session", "/work", { model: { providerID: "relay", modelID: "second" } })
  expect(choice("thinking-session", "/work").variant).toBe("high")
})
