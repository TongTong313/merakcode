import { expect, test } from "vitest"
import * as Alibaba from "../../../src/agent/model/catalog/alibaba"
import { load, parseItems } from "./fixture"

const body = await load("alibaba")
const models = parseItems(body.output.models, Alibaba.parse)
const byID = (id: string) => models.find((model) => model.id === id)

test("Bailian keeps only text chat models", () => {
  expect(models.map((model) => model.id)).toEqual([
    "qwen3.8-max",
    "qwen3.7-flash",
    "qwen-plus",
    "deepseek-v4.1-flash",
    "kimi-k3",
    "qwen3.5-plus",
    "deepseek-v4-pro",
    "glm-5.3",
  ])
})

test("Bailian qwen3.8-max carries its real limits, modalities and tools", () => {
  expect(byID("qwen3.8-max")).toMatchObject({
    name: "Qwen3.8-Max",
    context: 1_000_000,
    output: 131072,
    input: ["image", "text", "video"],
    outputModalities: ["text"],
    reasoning: true,
    toolcall: true,
    releaseDate: "2026-08-02",
  })
})

test("Bailian prices are yuan per million tokens", () => {
  expect(byID("qwen3.8-max")?.cost).toEqual({ currency: "CNY", input: 12, output: 36, cacheRead: 1.5, cacheWrite: 15 })
})

test("Bailian length-tiered prices become tiers", () => {
  const cost = byID("qwen3.7-flash")?.cost
  expect(cost).toMatchObject({ currency: "CNY", input: 0.2, output: 0.8, cacheRead: 0.04 })
  expect(cost?.tiers).toEqual([
    { above: 32_000, input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite: 0.75 },
    { above: 256_000, input: 1.2, output: 4.8, cacheRead: 0.24, cacheWrite: 1.5 },
  ])
})

test("Bailian peak and off-peak prices are not used as the base price", () => {
  expect(byID("deepseek-v4.1-flash")?.cost).toBeUndefined()
  expect(byID("kimi-k3")?.cost).toMatchObject({ input: 20, output: 100, cacheRead: 2 })
})

test("Bailian thinking prices are kept separately", () => {
  const cost = byID("qwen-plus")?.cost
  expect(cost).toMatchObject({ input: 0.8, output: 2 })
  expect(cost?.thinking).toEqual({ input: 0.8, output: 8, cacheRead: 0.16, cacheWrite: 1 })
  expect(cost?.tiers?.[0]).toMatchObject({
    above: 128_000,
    input: 2.4,
    output: 20,
    thinking: { input: 2.4, output: 24 },
  })
})

test("a Bailian model with an offline date is deprecated", () => {
  expect(byID("qwen3.5-plus")?.status).toBe("deprecated")
  expect(byID("qwen3.8-max")?.status).toBeUndefined()
})
