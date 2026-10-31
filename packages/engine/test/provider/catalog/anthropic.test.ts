import { afterEach, expect, test } from "vitest"
import { Auth } from "@merakcode/engine/agent/model/credentials"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Provider } from "@merakcode/engine/agent/model/provider"
import * as Anthropic from "../../../src/agent/model/catalog/anthropic"
import { tmpdir } from "../../fixture/fixture"
import { load, parseItems, restoreCatalog, writeCatalog } from "./fixture"

const body = await load("anthropic")
const models = parseItems(body.data, Anthropic.parse)

afterEach(async () => {
  await restoreCatalog()
  await Auth.remove("anthropic")
})

test("Anthropic list fields map to the shared model and a row without id is skipped", () => {
  expect(models.map((model) => model.id)).toEqual(["claude-opus-5-5", "claude-sonnet-4-5"])
  expect(models[0]).toMatchObject({
    name: "Claude Opus 5.5",
    context: 1_000_000,
    output: 128000,
    input: ["text", "image", "pdf"],
    reasoning: true,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    canDisable: false,
    releaseDate: "2026-09-21",
  })
})

test("Anthropic levels follow capabilities.effort and a model that cannot disable thinking has no off", async () => {
  await writeCatalog("anthropic", models)
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    init: () => Auth.set("anthropic", { type: "api", key: "test-key" }),
    fn: async () => {
      const model = await Provider.getModel("anthropic", "claude-opus-5-5")
      expect(Object.keys(model.variants ?? {})).toEqual(["low", "medium", "high", "xhigh", "max"])
      expect(model.defaultVariant).toBe("medium")
    },
  })
})

test("an Anthropic model whose list says it supports no effort level only turns thinking on and off", async () => {
  expect(models[1]?.efforts).toEqual([])
  await writeCatalog("anthropic", models)
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    init: () => Auth.set("anthropic", { type: "api", key: "test-key" }),
    fn: async () => {
      const model = await Provider.getModel("anthropic", "claude-sonnet-4-5")
      expect(Object.keys(model.variants ?? {})).toEqual(["off", "on"])
      expect(model.variants?.on).toEqual({ thinking: { type: "enabled" } })
      expect(model.defaultVariant).toBe("on")
    },
  })
})
