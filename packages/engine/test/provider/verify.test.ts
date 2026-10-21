import { afterAll, beforeAll, expect, test } from "vitest"
import path from "path"
import { Filesystem } from "@merakcode/util/filesystem"
import { Http } from "@merakcode/util/http"
import { Instance } from "@merakcode/engine/project/instance"
import { ProviderVerify } from "@merakcode/engine/provider/verify"
import { tmpdir } from "../fixture/fixture"

// After connecting a provider, a minimal request surfaces a wrong key or region (China vs international Model Studio)
// right away instead of on the first chat. A local fake server plays the provider.

let server: Awaited<ReturnType<typeof Http.serve>>
let reply = () => new Response("unset", { status: 500 })
const requests: string[] = []

beforeAll(async () => {
  server = await Http.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { model?: string }
      requests.push(`${new URL(req.url).pathname} ${body.model ?? ""}`)
      return reply()
    },
  })
})
afterAll(() => server.stop(true))

const project = () =>
  tmpdir({
    init: (dir) =>
      Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          enabled_providers: ["alibaba-cn"],
          provider: { "alibaba-cn": { options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1` } } },
        }),
      ),
  })

test("returns ok using the provider's small model when the key works", async () => {
  reply = () =>
    Response.json({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 0,
      model: "qwen-flash",
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
  requests.length = 0
  await using tmp = await project()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect(await ProviderVerify.run("alibaba-cn")).toEqual({ ok: true, model: "qwen-flash" })
      expect(requests).toEqual(["/v1/chat/completions qwen-flash"])
    },
  })
})

test("returns the provider's error as-is without retrying when the key is wrong", async () => {
  reply = () =>
    Response.json(
      { error: { message: "Incorrect API key provided.", type: "invalid_request_error", code: "invalid_api_key" } },
      { status: 401 },
    )
  requests.length = 0
  await using tmp = await project()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await ProviderVerify.run("alibaba-cn")
      expect(result.ok).toBe(false)
      expect(!result.ok && result.error).toContain("Incorrect API key provided")
      expect(requests).toHaveLength(1)
    },
  })
})

test("reports an unconnected provider without sending a request", async () => {
  requests.length = 0
  await using tmp = await project()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect(await ProviderVerify.run("openai")).toEqual({ ok: false, error: "provider is not connected: openai" })
      expect(requests).toHaveLength(0)
    },
  })
})
