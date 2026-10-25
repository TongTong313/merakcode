import { expect, test } from "vitest"
import * as OpenRouter from "../../../src/provider/catalog/openrouter"
import { load, parseItems } from "./fixture"

const body = await load("openrouter")
const models = parseItems(body.data, OpenRouter.parse)
const byID = (id: string) => models.find((model) => model.id === id)

test("OpenRouter skips batch variants and latest aliases", () => {
  expect(models.map((model) => model.id)).toEqual([
    "anthropic/claude-opus-4.8",
    "anthropic/claude-opus-5.5",
    "anthropic/claude-sonnet-4.5",
    "openai/gpt-5.2",
    "deepseek/deepseek-v4-pro",
    "moonshotai/kimi-k3",
    "google/gemini-4-argon",
    "recursive/flint-v1.0:free",
  ])
})

test("OpenRouter without supported_efforts exposes no effort levels", () => {
  expect(byID("anthropic/claude-sonnet-4.5")).toMatchObject({ reasoning: true })
  expect(byID("anthropic/claude-sonnet-4.5")?.efforts).toBeUndefined()
  expect(byID("anthropic/claude-sonnet-4.5")?.canDisable).toBeUndefined()
  expect(byID("recursive/flint-v1.0:free")).toMatchObject({ reasoning: true, canDisable: false })
  expect(byID("recursive/flint-v1.0:free")?.efforts).toBeUndefined()
})

test("OpenRouter levels drop none, which marks a model that can turn thinking off", () => {
  expect(byID("anthropic/claude-opus-4.8")).toMatchObject({
    efforts: ["max", "xhigh", "high", "medium", "low"],
    canDisable: true,
    defaultEffort: "high",
  })
  expect(byID("anthropic/claude-opus-5.5")).toMatchObject({ canDisable: false })
})

test("OpenRouter per-token prices become per-million prices", () => {
  const model = byID("anthropic/claude-opus-4.8")
  expect(model?.cost).toEqual({ currency: "USD", input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 })
  expect(model).toMatchObject({ context: 1_000_000, output: 128000, input: ["text", "image", "pdf"] })
})

test("OpenRouter long-context overrides become tiers and time-window overrides are ignored", async () => {
  const pricing = await load("openrouter-pricing")
  const longContext = OpenRouter.parse({ id: "docs/long-context", pricing: pricing.longContext })
  expect(longContext?.cost).toEqual({
    currency: "USD",
    input: 2.5,
    output: 10,
    tiers: [{ above: 200_000, input: 5, output: 20 }],
  })
  const timeWindow = OpenRouter.parse({ id: "docs/time-window", pricing: pricing.timeWindow })
  expect(timeWindow?.cost?.tiers).toBeUndefined()
})
