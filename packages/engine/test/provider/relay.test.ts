import { expect, test } from "vitest"
import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { generateText } from "ai"
import { Filesystem } from "@merakcode/util/filesystem"
import { Http } from "@merakcode/util/http"
import { Auth } from "@merakcode/engine/auth/index"
import { Instance } from "@merakcode/engine/project/instance"
import { Provider } from "@merakcode/engine/provider/provider"
import { Relay } from "@merakcode/engine/provider/relay"
import { Server } from "@merakcode/engine/server/server"
import { LLM } from "@merakcode/engine/session/llm"
import type { Agent } from "@merakcode/engine/agent/agent"
import type { Message } from "@merakcode/engine/session/message"
import { tmpdir } from "../fixture/fixture"

test("a relay model list keeps the context and output limits the station returned", () => {
  const models = Relay.readList({
    data: [{ id: "claude-sonnet-4-5", context_length: 200_000, max_output_tokens: 64_000 }],
  })

  expect(models).toEqual([
    {
      id: "claude-sonnet-4-5",
      context: 200_000,
      output: 64_000,
      contextFrom: "relay",
      outputFrom: "relay",
    },
  ])
})

test("other known station field names for limits are accepted", () => {
  const models = Relay.readList({
    data: [
      { id: "a", limit: { context: 1, output: 2 } },
      { id: "b", context_window: 3, max_tokens: 4 },
      { id: "c", max_context_length: 5, max_completion_tokens: 6 },
      { id: "d", max_input_tokens: 7 },
      { id: "e", max_model_len: 8 },
    ],
  })

  expect(models).toEqual([
    { id: "a", context: 1, output: 2, contextFrom: "relay", outputFrom: "relay" },
    { id: "b", context: 3, output: 4, contextFrom: "relay", outputFrom: "relay" },
    { id: "c", context: 5, output: 6, contextFrom: "relay", outputFrom: "relay" },
    { id: "d", context: 7, contextFrom: "relay" },
    { id: "e", context: 8, contextFrom: "relay" },
  ])
})

test("a model id the station did not describe takes its limits from the catalog", () => {
  const models = Relay.resolve({
    drafts: Relay.readList({ data: [{ id: "claude-sonnet-4-5" }] }),
    catalog: {
      "claude-sonnet-4-5": { context: 200_000, output: 64_000 },
    },
  })

  expect(models).toEqual([
    {
      id: "claude-sonnet-4-5",
      context: 200_000,
      output: 64_000,
      contextFrom: "catalog",
      outputFrom: "catalog",
      endpoint: "anthropic",
      image: true,
      reasoning: true,
      toolcall: true,
    },
  ])
})

test("a prefixed model id uses the catalog entry without the provider prefix", () => {
  const models = Relay.resolve({
    drafts: Relay.readList({ data: [{ id: "openai/gpt-5" }] }),
    catalog: { "gpt-5": { context: 111_111, output: 22_222 } },
  })

  expect(models).toEqual([
    {
      id: "openai/gpt-5",
      context: 111_111,
      output: 22_222,
      contextFrom: "catalog",
      outputFrom: "catalog",
      endpoint: "openai-responses",
      image: false,
      reasoning: false,
      toolcall: true,
    },
  ])
})

test("an unknown model uses fallback limits and records that they were not stated", () => {
  const models = Relay.resolve({
    drafts: Relay.readList({ data: [{ id: "claude-private" }, { id: "local-model" }] }),
    catalog: {},
  })

  expect(models).toEqual([
    {
      id: "claude-private",
      context: 200_000,
      output: 64_000,
      contextFrom: "fallback",
      outputFrom: "fallback",
      endpoint: "anthropic",
      image: true,
      reasoning: true,
      toolcall: true,
    },
    {
      id: "local-model",
      context: 128_000,
      output: 16_000,
      contextFrom: "fallback",
      outputFrom: "fallback",
      endpoint: "openai-chat",
      image: false,
      reasoning: false,
      toolcall: true,
    },
  ])
})

test("discover asks the station for its model list and keeps the limits it returned", async () => {
  const seen: { path?: string; authorization?: string | string[] } = {}
  const server = createServer((request, response) => {
    seen.path = request.url
    seen.authorization = request.headers.authorization
    response.setHeader("content-type", "application/json")
    response.end(
      JSON.stringify({ data: [{ id: "claude-sonnet-4-5", context_length: 180_000, max_output_tokens: 8_000 }] }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address() as AddressInfo
  try {
    const result = await Relay.discover({
      baseURL: `http://127.0.0.1:${address.port}`,
      key: "sk-test",
      kind: "claude-code",
    })
    expect(seen).toEqual({ path: "/v1/models", authorization: "Bearer sk-test" })
    expect(result).toEqual({
      models: [
        {
          id: "claude-sonnet-4-5",
          context: 180_000,
          output: 8_000,
          contextFrom: "relay",
          outputFrom: "relay",
          endpoint: "anthropic",
          image: true,
          reasoning: true,
          toolcall: true,
        },
      ],
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test("discover fills a bare model id from the model catalog", async () => {
  const fixture = JSON.parse(await readFile(new URL("../tool/fixtures/models-api.json", import.meta.url), "utf8")) as {
    openai: { models: Record<string, { limit: { context: number; output: number } }> }
  }
  const limit = fixture.openai.models["gpt-4.1-nano"]!.limit
  const server = createServer((_request, response) => {
    response.end(JSON.stringify({ data: [{ id: "gpt-4.1-nano" }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address() as AddressInfo
  try {
    const result = await Relay.discover({
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      key: "sk-test",
      kind: "standard",
    })
    expect(result).toEqual({
      models: [
        {
          id: "gpt-4.1-nano",
          context: limit.context,
          output: limit.output,
          contextFrom: "catalog",
          outputFrom: "catalog",
          endpoint: "openai-responses",
          image: true,
          reasoning: false,
          toolcall: true,
        },
      ],
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test("a claude code group sends bearer auth, the claude code beta header, and a claude code user agent", async () => {
  const seen: {
    path?: string
    authorization?: string | null
    beta?: string | null
    model?: string
    userAgent?: string | null
  } = {}
  const server = await Http.serve({
    async fetch(request) {
      const body = (await request.json()) as { model?: string }
      seen.path = new URL(request.url).pathname
      seen.authorization = request.headers.get("authorization")
      seen.beta = request.headers.get("anthropic-beta")
      seen.userAgent = request.headers.get("user-agent")
      seen.model = body.model
      return Response.json({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    },
  })
  try {
    await using tmp = await tmpdir({
      init: (dir) =>
        Filesystem.write(
          path.join(dir, "merakcode.json"),
          JSON.stringify({
            provider: {
              "packy-cc": {
                name: "Packy",
                npm: "@ai-sdk/anthropic",
                api: `${server.url.origin}/v1`,
                relay: { station: "packy", group: "cc", kind: "claude-code" },
                models: {
                  "claude-sonnet-4-5": { name: "claude-sonnet-4-5", limit: { context: 180_000, output: 8_000 } },
                },
              },
            },
          }),
        ),
    })
    await Instance.provide({
      directory: tmp.path,
      init: () => Auth.set("packy-cc", { type: "api", key: "sk-cc" }),
      fn: async () => {
        const model = await Provider.getModel("packy-cc", "claude-sonnet-4-5")
        expect(model.limit.context).toBe(180_000)
        await generateText({ model: await Provider.getLanguage(model), prompt: "Reply with OK.", maxRetries: 0 })
        expect(seen.path).toBe("/v1/messages")
        expect(seen.authorization).toBe("Bearer sk-cc")
        expect(seen.beta).toContain("claude-code-20250219")
        expect(seen.userAgent).toMatch(/^claude-cli\//)
        expect(seen.model).toBe("claude-sonnet-4-5")
      },
    })
  } finally {
    await Auth.remove("packy-cc")
    await server.stop(true)
  }
})

test("a claude code group keeps the claude code user agent on a chat request", async () => {
  let userAgent: string | null = null
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg-1",
        model: "claude-sonnet-4-5",
        usage: { input_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null, container: null },
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null },
    },
    { type: "message_stop" },
  ]
  const server = await Http.serve({
    async fetch(request) {
      userAgent = request.headers.get("user-agent")
      const payload = events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n") + "\n\n"
      return new Response(payload, { headers: { "content-type": "text/event-stream" } })
    },
  })
  try {
    await using tmp = await tmpdir({
      init: (dir) =>
        Filesystem.write(
          path.join(dir, "merakcode.json"),
          JSON.stringify({
            provider: {
              "packy-cc": {
                name: "Packy",
                npm: "@ai-sdk/anthropic",
                api: `${server.url.origin}/v1`,
                relay: { station: "packy", group: "cc", kind: "claude-code" },
                models: {
                  "claude-sonnet-4-5": { name: "claude-sonnet-4-5", limit: { context: 180_000, output: 8_000 } },
                },
              },
            },
          }),
        ),
    })
    await Instance.provide({
      directory: tmp.path,
      init: () => Auth.set("packy-cc", { type: "api", key: "sk-cc" }),
      fn: async () => {
        const model = await Provider.getModel("packy-cc", "claude-sonnet-4-5")
        const sessionID = "relay-cc"
        const agent = {
          id: "test",
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: "user-cc",
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.id,
          model: { providerID: "packy-cc", modelID: model.id },
        } satisfies Message.UserInfo
        const stream = await LLM.stream({
          user,
          sessionID,
          model,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })
        for await (const _ of stream.stream) {
          // Drain the chat stream so the request is sent.
        }
        expect(userAgent).toMatch(/^claude-cli\//)
      },
    })
  } finally {
    await Auth.remove("packy-cc")
    await server.stop(true)
  }
})

test("a codex group sends a responses request without an official prompt cache key", async () => {
  const seen: { path?: string; authorization?: string | null; body?: { prompt_cache_key?: string; store?: boolean } } =
    {}
  const events = [
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "OK" },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ]
  const server = await Http.serve({
    async fetch(request) {
      seen.path = new URL(request.url).pathname
      seen.authorization = request.headers.get("authorization")
      seen.body = (await request.json()) as { prompt_cache_key?: string; store?: boolean }
      const payload = events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n") + "\n\n"
      return new Response(payload, { headers: { "content-type": "text/event-stream" } })
    },
  })
  try {
    await using tmp = await tmpdir({
      init: (dir) =>
        Filesystem.write(
          path.join(dir, "merakcode.json"),
          JSON.stringify({
            provider: {
              "packy-codex": {
                name: "Packy",
                npm: "@ai-sdk/openai",
                api: `${server.url.origin}/v1`,
                relay: { station: "packy", group: "codex", kind: "codex" },
                models: { "gpt-6-astra": { name: "gpt-6-astra", limit: { context: 200_000, output: 32_000 } } },
              },
            },
          }),
        ),
    })
    await Instance.provide({
      directory: tmp.path,
      init: () => Auth.set("packy-codex", { type: "api", key: "sk-codex" }),
      fn: async () => {
        const model = await Provider.getModel("packy-codex", "gpt-6-astra")
        const sessionID = "relay-codex"
        const agent = {
          id: "test",
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: "user-codex",
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.id,
          model: { providerID: "packy-codex", modelID: model.id },
        } satisfies Message.UserInfo
        const stream = await LLM.stream({
          user,
          sessionID,
          model,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })
        for await (const _ of stream.stream) {
        }
        expect(seen.path).toBe("/v1/responses")
        expect(seen.authorization).toBe("Bearer sk-codex")
        expect(seen.body?.prompt_cache_key).toBeUndefined()
        expect(seen.body?.store).toBe(false)
      },
    })
  } finally {
    await Auth.remove("packy-codex")
    await server.stop(true)
  }
})

test("a custom group uses the chosen anthropic auth and extra headers", async () => {
  const seen: { authorization?: string | null; apiKey?: string | null; group?: string | null; beta?: string | null } =
    {}
  const server = await Http.serve({
    async fetch(request) {
      seen.authorization = request.headers.get("authorization")
      seen.apiKey = request.headers.get("x-api-key")
      seen.group = request.headers.get("x-group")
      seen.beta = request.headers.get("anthropic-beta")
      const body = (await request.json()) as { model?: string }
      return Response.json({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    },
  })
  try {
    await using tmp = await tmpdir({
      init: (dir) =>
        Filesystem.write(
          path.join(dir, "merakcode.json"),
          JSON.stringify({
            provider: {
              "packy-vip": {
                name: "Packy",
                npm: "@ai-sdk/anthropic",
                api: `${server.url.origin}/v1`,
                relay: { station: "packy", group: "vip", kind: "custom", auth: "bearer" },
                options: { headers: { "X-Group": "vip" } },
                models: { "claude-custom": { name: "claude-custom", limit: { context: 1_000, output: 100 } } },
              },
            },
          }),
        ),
    })
    await Instance.provide({
      directory: tmp.path,
      init: () => Auth.set("packy-vip", { type: "api", key: "sk-vip" }),
      fn: async () => {
        const model = await Provider.getModel("packy-vip", "claude-custom")
        await generateText({ model: await Provider.getLanguage(model), prompt: "Reply with OK.", maxRetries: 0 })
        expect(seen.authorization).toBe("Bearer sk-vip")
        expect(seen.apiKey).toBeNull()
        expect(seen.group).toBe("vip")
        expect(seen.beta ?? "").not.toContain("claude-code-20250219")
      },
    })
  } finally {
    await Auth.remove("packy-vip")
    await server.stop(true)
  }
})

test("a standard group sends each model with its own protocol and without claude code headers", async () => {
  const seen: Array<{ path: string; authorization: string | null; apiKey: string | null; beta: string | null }> = []
  const server = await Http.serve({
    async fetch(request) {
      const url = new URL(request.url)
      seen.push({
        path: url.pathname,
        authorization: request.headers.get("authorization"),
        apiKey: request.headers.get("x-api-key"),
        beta: request.headers.get("anthropic-beta"),
      })
      if (url.pathname.endsWith("/messages")) {
        const body = (await request.json()) as { model?: string }
        return Response.json({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text: "OK" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      }
      return Response.json({
        id: "chatcmpl-1",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    },
  })
  try {
    await using tmp = await tmpdir({
      init: (dir) =>
        Filesystem.write(
          path.join(dir, "merakcode.json"),
          JSON.stringify({
            provider: {
              "packy-std": {
                name: "Packy",
                api: `${server.url.origin}/v1`,
                relay: { station: "packy", group: "std", kind: "standard" },
                models: {
                  "claude-sonnet-4-5": {
                    name: "claude-sonnet-4-5",
                    provider: { npm: "@ai-sdk/anthropic" },
                    limit: { context: 200_000, output: 8_000 },
                  },
                  "gpt-4o": {
                    name: "gpt-4o",
                    provider: { npm: "@ai-sdk/openai-compatible" },
                    limit: { context: 128_000, output: 16_000 },
                  },
                },
              },
            },
          }),
        ),
    })
    await Instance.provide({
      directory: tmp.path,
      init: () => Auth.set("packy-std", { type: "api", key: "sk-std" }),
      fn: async () => {
        const claude = await Provider.getModel("packy-std", "claude-sonnet-4-5")
        const chat = await Provider.getModel("packy-std", "gpt-4o")
        await generateText({ model: await Provider.getLanguage(claude), prompt: "Reply with OK.", maxRetries: 0 })
        await generateText({ model: await Provider.getLanguage(chat), prompt: "Reply with OK.", maxRetries: 0 })
        expect(seen[0]).toMatchObject({ path: "/v1/messages", apiKey: "sk-std", authorization: null })
        expect(seen[0]?.beta ?? "").not.toContain("claude-code-20250219")
        expect(seen[1]).toMatchObject({ path: "/v1/chat/completions", authorization: "Bearer sk-std" })
      },
    })
  } finally {
    await Auth.remove("packy-std")
    await server.stop(true)
  }
})

test("discover names the protocol a standard group will use for each model", async () => {
  const server = createServer((_request, response) => {
    response.end(
      JSON.stringify({
        data: [{ id: "claude-a" }, { id: "gpt-5" }, { id: "widget" }, { id: "claude-via-chat", endpoints: ["openai"] }],
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address() as AddressInfo
  try {
    const result = await Relay.discover({
      baseURL: `http://127.0.0.1:${address.port}`,
      key: "sk-test",
      kind: "standard",
    })
    if ("error" in result) throw new Error(result.error)
    expect(result.models.map((model) => ({ id: model.id, endpoint: model.endpoint }))).toEqual([
      { id: "claude-a", endpoint: "anthropic" },
      { id: "gpt-5", endpoint: "openai-responses" },
      { id: "widget", endpoint: "openai-chat" },
      { id: "claude-via-chat", endpoint: "openai-chat" },
    ])
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test("capabilities come from the station, then the catalog, then the model family", () => {
  const models = Relay.resolve({
    drafts: Relay.readList({
      data: [
        { id: "from-station", vision: true, reasoning: false, tool_call: true },
        { id: "gpt-4.1-nano" },
        { id: "claude-private" },
        { id: "local-model" },
      ],
    }),
    catalog: {
      "from-station": { image: false, reasoning: true, toolcall: false },
      "gpt-4.1-nano": { image: true, reasoning: false, toolcall: true },
    },
  })

  expect(
    models.map((model) => ({ id: model.id, image: model.image, reasoning: model.reasoning, toolcall: model.toolcall })),
  ).toEqual([
    { id: "from-station", image: true, reasoning: false, toolcall: true },
    { id: "gpt-4.1-nano", image: true, reasoning: false, toolcall: true },
    { id: "claude-private", image: true, reasoning: true, toolcall: true },
    { id: "local-model", image: false, reasoning: false, toolcall: true },
  ])
})

test("clients can ask the engine to list a relay's models", async () => {
  const station = createServer((_request, response) => {
    response.end(
      JSON.stringify({ data: [{ id: "claude-sonnet-4-5", context_length: 180_000, max_output_tokens: 8_000 }] }),
    )
  })
  await new Promise<void>((resolve) => station.listen(0, "127.0.0.1", () => resolve()))
  const address = station.address() as AddressInfo
  try {
    const response = await Server.App().request("http://localhost/provider/relay/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseURL: `http://127.0.0.1:${address.port}`,
        key: "sk-test",
        kind: "claude-code",
      }),
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<{ id: string; context: number; contextFrom: string; endpoint: string }>
    }
    expect(body.models[0]).toMatchObject({
      id: "claude-sonnet-4-5",
      context: 180_000,
      contextFrom: "relay",
      endpoint: "anthropic",
    })
  } finally {
    await new Promise((resolve) => station.close(resolve))
  }
})
