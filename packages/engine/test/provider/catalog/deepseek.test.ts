import { afterAll, expect, test } from "vitest"
import { Auth } from "@merakcode/engine/agent/model/credentials"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Provider } from "@merakcode/engine/agent/model/provider"
import { Server } from "@merakcode/engine/app/server/server"
import { Http } from "@merakcode/util/http"
import * as DeepSeek from "../../../src/agent/model/catalog/deepseek"
import { globalConfig, tmpdir } from "../../fixture/fixture"
import { load, parseItems, restoreCatalog } from "./fixture"

const body = await load("deepseek")

afterAll(async () => {
  await restoreCatalog()
  await Auth.remove("deepseek")
})

test("a saved DeepSeek key brings its real model list into the provider list", async () => {
  await using server = await Http.serve({
    fetch(request) {
      if (new URL(request.url).pathname !== "/models") return new Response("missing", { status: 404 })
      return Response.json(body)
    },
  })
  await using home = await tmpdir({
    config: { provider: { deepseek: { options: { baseURL: server.url.origin } } } },
  })
  using _ = globalConfig(home.path)
  await using tmp = await tmpdir()
  const saved = await Server.App().request("/auth/deepseek", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "api", key: "test-key" }),
  })
  expect(saved.status).toBe(200)
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const model = (await Provider.list()).deepseek?.models["deepseek-v4-pro"]
      expect(model).toBeDefined()
      expect(Object.keys(model!.variants!)).toEqual(["off", "low", "high", "max"])
      expect(model!.defaultVariant).toBe("high")
      expect(model!.limit).toMatchObject({ context: 1048576, output: 393216 })
    },
  })
})

test("deepseek-flash accepts images", () => {
  const model = DeepSeek.parse(body.data[0])
  expect(model).toMatchObject({ id: "deepseek-flash", name: "DeepSeek-V4.1-Flash", input: ["text", "image"] })
})

test("a malformed item is skipped and the rest of the list is kept", () => {
  const models = parseItems([body.data[0], { name: "no id" }, body.data[1]], DeepSeek.parse)
  expect(models.map((model) => model.id)).toEqual(["deepseek-flash", "deepseek-v4-pro"])
})
