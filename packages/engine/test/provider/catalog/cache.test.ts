import fs from "fs/promises"
import path from "path"
import { afterEach, expect, test } from "vitest"
import { Auth } from "@merakcode/engine/auth/index"
import { Global } from "@merakcode/engine/global/index"
import { Instance } from "@merakcode/engine/project/instance"
import { Provider } from "@merakcode/engine/provider/provider"
import * as Catalog from "../../../src/provider/catalog"
import { Http } from "@merakcode/util/http"
import { Filesystem } from "@merakcode/util/filesystem"
import { GlobalBus } from "@merakcode/engine/bus/global"
import { globalConfig, tmpdir } from "../../fixture/fixture"
import { load, restoreCatalog } from "./fixture"

const cached = (name: string) => path.join(Global.Path.cache, "catalog", `${name}.json`)

afterEach(async () => {
  await restoreCatalog()
  await Auth.remove("deepseek")
  await Auth.remove("zhipuai")
  await Auth.remove("openai")
})

/** A DeepSeek list endpoint plus a global config pointing at it. */
async function deepseekEndpoint() {
  const body = await load("deepseek")
  const hits = { count: 0 }
  const server = await Http.serve({
    fetch() {
      hits.count++
      return Response.json(body)
    },
  })
  const home = await tmpdir({ config: { provider: { deepseek: { options: { baseURL: server.url.origin } } } } })
  const config = globalConfig(home.path)
  return {
    hits,
    async [Symbol.asyncDispose]() {
      config[Symbol.dispose]()
      await home[Symbol.asyncDispose]()
      await server.stop(true)
    },
  }
}

test("a connected provider whose model list returns 500 reports MRK-2010 and keeps the cached list", async () => {
  const previous = await Filesystem.readText(cached("deepseek"))
  await using server = await Http.serve({ fetch: () => new Response("no", { status: 500 }) })
  await using home = await tmpdir({
    config: { provider: { deepseek: { options: { baseURL: server.url.origin } } } },
  })
  using config = globalConfig(home.path)
  await Auth.set("deepseek", { type: "api", key: "test-key" })
  const seen: Array<{ reason?: string; providerID?: string; error?: { code?: string; data?: { message?: string } } }> =
    []
  const onEvent = (event: { payload: { type: string; properties: (typeof seen)[number] } }) => {
    if (event.payload.type === "provider.changed") seen.push(event.payload.properties)
  }
  GlobalBus.on("event", onEvent)
  try {
    const report = await Provider.refreshCatalog("deepseek", true)
    expect(report.updated).toBe(false)
    expect(report.failures).toHaveLength(1)
    expect(report.failures[0]).toMatchObject({
      name: "CatalogRefreshError",
      code: "MRK-2010",
      data: { providerID: "deepseek", statusCode: 500 },
    })
    expect(report.failures[0]?.data.message).not.toContain("test-key")
    expect(seen).toEqual([
      expect.objectContaining({
        providerID: "deepseek",
        reason: "refresh-failed",
        error: expect.objectContaining({ code: "MRK-2010" }),
      }),
    ])
    expect(await Filesystem.readText(cached("deepseek"))).toBe(previous)
  } finally {
    GlobalBus.off("event", onEvent)
    config[Symbol.dispose]()
  }
})

test("a model list that rejects the key reports MRK-2001", async () => {
  await using server = await Http.serve({ fetch: () => new Response("no", { status: 401 }) })
  await using home = await tmpdir({
    config: { provider: { deepseek: { options: { baseURL: server.url.origin } } } },
  })
  using config = globalConfig(home.path)
  await Auth.set("deepseek", { type: "api", key: "test-key" })
  try {
    const report = await Provider.refreshCatalog("deepseek", true)
    expect(report.updated).toBe(false)
    expect(report.failures[0]).toMatchObject({
      name: "CatalogRefreshError",
      code: "MRK-2001",
      data: { providerID: "deepseek", statusCode: 401 },
    })
  } finally {
    config[Symbol.dispose]()
  }
})

test("a failed refresh keeps the previous cache", async () => {
  const previous = await Filesystem.readText(cached("deepseek"))
  await using server = await Http.serve({ fetch: () => new Response("no", { status: 500 }) })
  expect((await Catalog.refresh("deepseek", { key: "test-key", baseURL: server.url.origin })).ok).toBe(false)
  expect(await Filesystem.readText(cached("deepseek"))).toBe(previous)
})

test("a connected official provider without any cache stays connected with no models", async () => {
  await fs.rm(cached("zhipuai"), { force: true })
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    init: () => Auth.set("zhipuai", { type: "api", key: "test-key" }),
    fn: async () => {
      expect((await Provider.list())["zhipuai"]?.models).toEqual({})
    },
  })
})

test("entries older than an hour are refreshed and fresh ones are not", async () => {
  await using endpoint = await deepseekEndpoint()
  await Auth.set("deepseek", { type: "api", key: "test-key" })
  await Filesystem.write(cached("deepseek"), JSON.stringify({ fetchedAt: Date.now() - 2 * 60 * 60 * 1000, models: [] }))
  expect((await Provider.refreshCatalog("deepseek")).updated).toBe(true)
  expect(endpoint.hits.count).toBe(1)
  expect((await Provider.refreshCatalog("deepseek")).updated).toBe(true)
  expect(endpoint.hits.count).toBe(1)
})

test("a refresh that writes a new list updates the provider list without a restart", async () => {
  await using _ = await deepseekEndpoint()
  await using tmp = await tmpdir()
  const seen: Array<{ reason?: string; providerID?: string }> = []
  const onEvent = (event: { payload: { type: string; properties: (typeof seen)[number] } }) => {
    if (event.payload.type === "provider.changed") seen.push(event.payload.properties)
  }
  GlobalBus.on("event", onEvent)
  try {
    await Instance.provide({
      directory: tmp.path,
      init: () => Auth.set("deepseek", { type: "api", key: "test-key" }),
      fn: async () => {
        expect(Object.keys((await Provider.list()).deepseek?.models ?? {})).not.toContain("deepseek-v4-pro")
        const report = await Provider.refreshCatalog("deepseek", true)
        expect(report.failures).toEqual([])
        expect(Object.keys((await Provider.list()).deepseek?.models ?? {})).toContain("deepseek-v4-pro")
        expect(seen).toContainEqual(expect.objectContaining({ providerID: "deepseek", reason: "refreshed" }))
      },
    })
  } finally {
    GlobalBus.off("event", onEvent)
  }
})

test("without the public catalog, missing fields come from the fallback table", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    init: () => Auth.set("openai", { type: "api", key: "test-key" }),
    fn: async () => {
      const model = await Provider.getModel("openai", "gpt-5.2")
      expect(model.capabilities.temperature).toBe(false)
    },
  })
})
