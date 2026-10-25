import { afterAll, beforeAll, beforeEach, describe, expect, onTestFinished, test } from "vitest"
import path from "path"
import type { ModelMessage } from "ai"
import { LLM } from "@merakcode/engine/session/llm"
import { Instance } from "@merakcode/engine/project/instance"
import { Provider } from "@merakcode/engine/provider/provider"
import { ProviderTransform } from "@merakcode/engine/provider/transform"
import { tmpdir } from "../fixture/fixture"
import type { Agent } from "@merakcode/engine/agent/agent"
import type { Message } from "@merakcode/engine/session/message"
import { Filesystem } from "@merakcode/util/filesystem"
import { Http } from "@merakcode/util/http"
import { Config } from "../../src/config/config"
import { parseItems } from "../../src/provider/catalog/model"
import * as OpenRouter from "../../src/provider/catalog/openrouter"
import { load, restoreCatalog, writeCatalog } from "../provider/catalog/fixture"

describe("session.llm.hasToolCalls", () => {
  test("returns false for empty messages array", () => {
    expect(LLM.hasToolCalls([])).toBe(false)
  })

  test("returns false for messages with only text content", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi there" }],
      },
    ]
    expect(LLM.hasToolCalls(messages)).toBe(false)
  })

  test("returns true when messages contain tool-call", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "Run a command" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-123",
            toolName: "bash",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })

  test("returns true when messages contain tool-result", () => {
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-123",
            toolName: "bash",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })

  test("returns false for messages with string content", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: "Hello world",
      },
      {
        role: "assistant",
        content: "Hi there",
      },
    ]
    expect(LLM.hasToolCalls(messages)).toBe(false)
  })

  test("returns true when tool-call is mixed with text content", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me run that command" },
          {
            type: "tool-call",
            toolCallId: "call-456",
            toolName: "read",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })
})

type Capture = {
  url: URL
  headers: Headers
  body: Record<string, unknown>
}

const state = {
  server: null as Http.Server | null,
  queue: [] as Array<{ path: string; response: Response; resolve: (value: Capture) => void }>,
}

function deferred<T>() {
  const result = {} as { promise: Promise<T>; resolve: (value: T) => void }
  result.promise = new Promise((resolve) => {
    result.resolve = resolve
  })
  return result
}

function waitRequest(pathname: string, response: Response) {
  const pending = deferred<Capture>()
  state.queue.push({ path: pathname, response, resolve: pending.resolve })
  return pending.promise
}

beforeAll(async () => {
  state.server = await Http.serve({
    port: 0,
    async fetch(req) {
      const next = state.queue.shift()
      if (!next) {
        return new Response("unexpected request", { status: 500 })
      }

      const url = new URL(req.url)
      const body = (await req.json()) as Record<string, unknown>
      next.resolve({ url, headers: req.headers, body })

      if (!url.pathname.endsWith(next.path)) {
        return new Response("not found", { status: 404 })
      }

      return next.response
    },
  })
})

beforeEach(() => {
  state.queue.length = 0
})

afterAll(async () => {
  await state.server?.stop(true)
})

function createChatStream(text: string) {
  const payload =
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { role: "assistant" } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { content: text } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"

  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

async function loadFixture(providerID: string, modelID: string) {
  const fixturePath = path.join(import.meta.dirname, "fixtures/llm-models.json")
  const data = (await Filesystem.readJson(fixturePath)) as Record<
    string,
    { npm?: string; api?: string; models: Record<string, { id: string }> }
  >
  const provider = data[providerID]
  if (!provider) throw new Error(`Missing provider in fixture: ${providerID}`)
  const model = provider.models[modelID]
  if (!model) throw new Error(`Missing model in fixture: ${modelID}`)
  return { provider, model }
}

function createEventStream(chunks: unknown[], includeDone = false) {
  const lines = chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}`)
  if (includeDone) {
    lines.push("data: [DONE]")
  }
  const payload = lines.join("\n\n") + "\n\n"
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

function createEventResponse(chunks: unknown[], includeDone = false) {
  return new Response(createEventStream(chunks, includeDone), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

describe("session.llm.stream", () => {
  test("sends temperature, tokens, and reasoning options for openai-compatible models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "compatible"
    const modelID = "qwen-plus"
    const fixture = await loadFixture("alibaba", modelID)
    const model = fixture.model

    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("Hello"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(
          path.join(dir, "merakcode.json"),
          JSON.stringify({
            $schema: Config.SCHEMA,
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                name: "Compatible",
                npm: fixture.provider.npm ?? "@ai-sdk/openai-compatible",
                models: { [modelID]: model },
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(providerID, model.id)
        const sessionID = "session-test-1"
        const agent = {
          id: "test",
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.4,
          topP: 0.8,
        } satisfies Agent.Info

        const user = {
          id: "user-1",
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.id,
          model: { providerID, modelID: resolved.id },
          variant: "high",
        } satisfies Message.UserInfo

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        for await (const _ of stream.stream) {
        }

        const capture = await request
        const body = capture.body
        const headers = capture.headers
        const url = capture.url

        expect(url.pathname.startsWith("/v1/")).toBe(true)
        expect(url.pathname.endsWith("/chat/completions")).toBe(true)
        expect(headers.get("Authorization")).toBe("Bearer test-key")
        expect(headers.get("User-Agent") ?? "").toMatch(/^merakcode\//)

        expect(body.model).toBe(resolved.api.id)
        expect(body.temperature).toBe(0.4)
        expect(body.top_p).toBe(0.8)
        expect(body.stream).toBe(true)

        const maxTokens = (body.max_tokens as number | undefined) ?? (body.max_output_tokens as number | undefined)
        const expectedMaxTokens = ProviderTransform.maxOutputTokens(resolved)
        expect(maxTokens).toBe(expectedMaxTokens)

        const reasoning = (body.reasoningEffort as string | undefined) ?? (body.reasoning_effort as string | undefined)
        expect(reasoning).toBeUndefined()

        // The system prompt goes first as system messages, followed by the user message.
        const messages = body.messages as { role: string; content: unknown }[]
        const system = messages.filter((item) => item.role === "system")
        expect(messages.slice(0, system.length)).toEqual(system)
        expect(JSON.stringify(system)).toContain("You are a helpful assistant.")
        expect(messages.at(-1)).toMatchObject({ role: "user", content: "Hello" })
      },
    })
  })

  test("sends responses API payload for OpenAI models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const source = await loadFixture("openai", "gpt-5.2")
    const model = source.model

    const responseChunks = [
      {
        type: "response.created",
        response: {
          id: "resp-1",
          created_at: Math.floor(Date.now() / 1000),
          model: model.id,
          service_tier: null,
        },
      },
      {
        type: "response.output_text.delta",
        item_id: "item-1",
        delta: "Hello",
        logprobs: null,
      },
      {
        type: "response.completed",
        response: {
          incomplete_details: null,
          usage: {
            input_tokens: 1,
            input_tokens_details: null,
            output_tokens: 1,
            output_tokens_details: null,
          },
          service_tier: null,
        },
      },
    ]
    const request = waitRequest("/responses", createEventResponse(responseChunks, true))
    await writeCatalog("public", parseItems((await load("openrouter")).data, OpenRouter.parse))
    onTestFinished(restoreCatalog)

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(
          path.join(dir, "merakcode.json"),
          JSON.stringify({
            $schema: Config.SCHEMA,
            enabled_providers: ["openai"],
            provider: {
              openai: {
                name: "OpenAI",
                env: ["OPENAI_API_KEY"],
                npm: "@ai-sdk/openai",
                api: "https://api.openai.com/v1",
                models: {
                  [model.id]: model,
                },
                options: {
                  apiKey: "test-openai-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel("openai", model.id)
        const sessionID = "session-test-2"
        const agent = {
          id: "test",
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.2,
        } satisfies Agent.Info

        const user = {
          id: "user-2",
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.id,
          model: { providerID: "openai", modelID: resolved.id },
          variant: "high",
        } satisfies Message.UserInfo

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        for await (const _ of stream.stream) {
        }

        const capture = await request
        const body = capture.body

        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
        expect(body.model).toBe(resolved.api.id)
        expect(body.stream).toBe(true)
        expect((body.reasoning as { effort?: string } | undefined)?.effort).toBe("high")

        const maxTokens = body.max_output_tokens as number | undefined
        const expectedMaxTokens = ProviderTransform.maxOutputTokens(resolved)
        expect(maxTokens).toBe(expectedMaxTokens)
      },
    })
  })

  test("sends messages API payload for Anthropic models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "anthropic"
    const modelID = "claude-3-5-sonnet-20241022"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model

    const chunks = [
      {
        type: "message_start",
        message: {
          id: "msg-1",
          model: model.id,
          usage: {
            input_tokens: 3,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null, container: null },
        usage: {
          input_tokens: 3,
          output_tokens: 2,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      },
      { type: "message_stop" },
    ]
    const request = waitRequest("/messages", createEventResponse(chunks))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(
          path.join(dir, "merakcode.json"),
          JSON.stringify({
            $schema: Config.SCHEMA,
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-anthropic-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(providerID, model.id)
        const sessionID = "session-test-3"
        const agent = {
          id: "test",
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.4,
          topP: 0.9,
        } satisfies Agent.Info

        const user = {
          id: "user-3",
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.id,
          model: { providerID, modelID: resolved.id },
        } satisfies Message.UserInfo

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        for await (const _ of stream.stream) {
        }

        const capture = await request
        const body = capture.body

        expect(capture.url.pathname.endsWith("/messages")).toBe(true)
        expect(body.model).toBe(resolved.api.id)
        expect(body.max_tokens).toBe(ProviderTransform.maxOutputTokens(resolved))
        expect(body.temperature).toBe(0.4)
        // Anthropic rejects temperature and top_p together, so the provider drops top_p.
        expect(body.top_p).toBeUndefined()
      },
    })
  })

  // With the system prompt in instructions, cache markers must still land on the first two system parts; empty images
  // become a text notice so broken files never reach the model.
  test("Anthropic marks system prompts for caching and replaces empty images with a text notice", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")

    const providerID = "anthropic"
    const fixture = await loadFixture(providerID, "claude-3-5-sonnet-20241022")
    const chunks = [
      { type: "message_start", message: { id: "msg-1", model: fixture.model.id, usage: { input_tokens: 3 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]
    const request = waitRequest("/messages", createEventResponse(chunks))

    await using tmp = await tmpdir({
      init: (dir) =>
        Filesystem.write(
          path.join(dir, "merakcode.json"),
          JSON.stringify({
            $schema: Config.SCHEMA,
            enabled_providers: [providerID],
            provider: { [providerID]: { options: { apiKey: "k", baseURL: `${server.url.origin}/v1` } } },
          }),
        ),
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(providerID, fixture.model.id)
        const agent = {
          id: "test",
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const stream = await LLM.stream({
          user: {
            id: "user-cache",
            sessionID: "session-cache",
            role: "user",
            time: { created: Date.now() },
            agent: agent.id,
            model: { providerID, modelID: resolved.id },
          },
          sessionID: "session-cache",
          model: resolved,
          agent,
          system: ["Stable header.", "Changing tail."],
          systemPrepared: true,
          abort: new AbortController().signal,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "what is this" },
                { type: "file", mediaType: "image/png", data: "data:image/png;base64," },
              ],
            },
          ],
          tools: {},
        })
        for await (const _ of stream.stream) {
        }

        const body = (await request).body as {
          system: { text: string; cache_control?: unknown }[]
          messages: { content: { type: string; text?: string }[] }[]
        }
        expect(body.system.map((item) => item.text)).toEqual(["Stable header.", "Changing tail."])
        expect(body.system.every((item) => item.cache_control)).toBe(true)
        expect(body.messages[0].content.map((part) => part.type)).toEqual(["text", "text"])
        expect(body.messages[0].content[1].text).toBe(
          "ERROR: Image file is empty or corrupted. Please provide a valid image.",
        )
      },
    })
  })

  test("sends Google API payload for Gemini models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "google"
    const modelID = "gemini-2.5-flash"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model
    const pathSuffix = `/v1beta/models/${model.id}:streamGenerateContent`

    const chunks = [
      {
        candidates: [
          {
            content: {
              parts: [{ text: "Hello" }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 1,
          candidatesTokenCount: 1,
          totalTokenCount: 2,
        },
      },
    ]
    const request = waitRequest(pathSuffix, createEventResponse(chunks))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(
          path.join(dir, "merakcode.json"),
          JSON.stringify({
            $schema: Config.SCHEMA,
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-google-key",
                  baseURL: `${server.url.origin}/v1beta`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(providerID, model.id)
        const sessionID = "session-test-4"
        const agent = {
          id: "test",
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.3,
          topP: 0.8,
        } satisfies Agent.Info

        const user = {
          id: "user-4",
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.id,
          model: { providerID, modelID: resolved.id },
        } satisfies Message.UserInfo

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        for await (const _ of stream.stream) {
        }

        const capture = await request
        const body = capture.body
        const config = body.generationConfig as
          { temperature?: number; topP?: number; maxOutputTokens?: number } | undefined

        expect(capture.url.pathname).toBe(pathSuffix)
        expect(config?.temperature).toBe(0.3)
        expect(config?.topP).toBe(0.8)
        expect(config?.maxOutputTokens).toBe(ProviderTransform.maxOutputTokens(resolved))
      },
    })
  })

  test("off sends only the provider's disable field", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")
    await using tmp = await tmpdir({
      config: {
        enabled_providers: ["deepseek"],
        provider: { deepseek: { options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1` } } },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const body = await send("deepseek", "deepseek-reasoner", "off", "/chat/completions", chatReply())
        expect(body.thinking).toEqual({ type: "disabled" })
        expect(body.reasoning_effort).toBeUndefined()
      },
    })
  })

  test("an effort level is encoded for the SDK in use", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")
    const origin = server.url.origin
    await writeCatalog("public", parseItems((await load("openrouter")).data, OpenRouter.parse))
    await using tmp = await tmpdir({
      config: {
        provider: {
          anthropic: {
            options: { apiKey: "test-key", baseURL: `${origin}/v1` },
            models: { "claude-opus-4-8": { reasoning: true } },
          },
          google: {
            options: { apiKey: "test-key", baseURL: `${origin}/v1beta` },
            models: { "gemini-3-flash": { reasoning: true } },
          },
          openai: { options: { apiKey: "test-key", baseURL: `${origin}/v1` } },
          "alibaba-cn": {
            options: { apiKey: "test-key", baseURL: `${origin}/v1` },
            models: { "qwen3.8-max": { reasoning: true } },
          },
        },
      },
    })
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const anthropic = await send("anthropic", "claude-opus-4-8", "high", "/messages", anthropicReply())
          expect(anthropic.output_config).toMatchObject({ effort: "high" })
          const google = await send("google", "gemini-3-flash", "low", ":streamGenerateContent", googleReply())
          expect((google.generationConfig as { thinkingConfig?: unknown }).thinkingConfig).toEqual({
            includeThoughts: true,
            thinkingLevel: "low",
          })
          const openai = await send("openai", "gpt-5.2", "xhigh", "/responses", responsesReply())
          expect(openai.reasoning).toMatchObject({ effort: "xhigh" })
          const bailian = await send("alibaba-cn", "qwen3.8-max", "xhigh", "/chat/completions", chatReply())
          expect(bailian.reasoning_effort).toBe("xhigh")
          expect(bailian.enable_thinking).toBe(true)
        },
      })
    } finally {
      await restoreCatalog()
    }
  })

  test("no hardcoded default effort is sent when the user picked a level", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")
    await writeCatalog("public", parseItems((await load("openrouter")).data, OpenRouter.parse))
    await using tmp = await tmpdir({
      config: { provider: { openai: { options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1` } } } },
    })
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const body = await send("openai", "gpt-5.2", "low", "/responses", responsesReply())
          expect(body.reasoning).toMatchObject({ effort: "low" })
        },
      })
    } finally {
      await restoreCatalog()
    }
  })
})

/** Streams one reply for the given model and level and returns the request body the SDK sent. */
async function send(providerID: string, modelID: string, variant: string, pathname: string, response: Response) {
  const request = waitRequest(pathname, response)
  const model = await Provider.getModel(providerID, modelID)
  const stream = await LLM.stream({
    user: {
      id: `user-${providerID}`,
      sessionID: "session-levels",
      role: "user",
      time: { created: Date.now() },
      agent: "test",
      model: { providerID, modelID },
      variant,
    },
    sessionID: "session-levels",
    model,
    agent: {
      id: "test",
      name: "test",
      mode: "primary",
      options: {},
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    },
    system: [],
    abort: new AbortController().signal,
    messages: [{ role: "user", content: "Hello" }],
    tools: {},
  })
  for await (const _ of stream.stream) {
  }
  return (await request).body
}

function chatReply() {
  return new Response(createChatStream("Hello"), { status: 200, headers: { "Content-Type": "text/event-stream" } })
}

function anthropicReply() {
  return createEventResponse([
    { type: "message_start", message: { id: "msg-levels", model: "m", usage: { input_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ])
}

function googleReply() {
  return createEventResponse([
    {
      candidates: [{ content: { parts: [{ text: "Hello" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    },
  ])
}

function responsesReply() {
  return createEventResponse(
    [
      {
        type: "response.completed",
        response: { incomplete_details: null, usage: { input_tokens: 1, output_tokens: 1 }, service_tier: null },
      },
    ],
    true,
  )
}
