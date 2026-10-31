import { afterEach, expect, test } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import z from "zod"
import { Instance } from "../../src/infra/project/instance"
import { Loop } from "../../src/agent/loop"
import { Session } from "../../src/agent/session"
import { ToolRegistry } from "../../src/agent/tools/registry"
import { MemoryExtract } from "../../src/agent/memory/extract"
import { SessionMemory } from "../../src/agent/memory/session-memory/session-memory"
import { AutoDream } from "../../src/agent/memory/dream/dream"
import { tmpdir } from "../fixture/fixture"

afterEach(() => Instance.disposeAll())

for (const scenario of ["normal", "unknown", "tool-stop", "error", "cancel", "retry", "child"] as const) {
  test(`turn completion schedules each eligible memory job once for ${scenario}`, async () => {
    const started = Promise.withResolvers<void>()
    let rootRequests = 0
    const server = createServer(async (request, response) => {
      let raw = ""
      for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw) as {
        model?: string
        messages: { role: string; content: unknown }[]
        tools?: { function?: { name: string } }[]
      }
      const content = body.messages.findLast((message) => message.role === "user")?.content
      const text =
        typeof content === "string" ? content : (content as { text?: string }[]).map((p) => p.text ?? "").join("")
      const primary = body.model === "qwen-plus" && text.startsWith("completion-case")
      if (primary) {
        rootRequests++
      }
      if (primary && scenario === "cancel") {
        started.resolve()
        return
      }
      if (primary && (scenario === "error" || (scenario === "retry" && rootRequests === 1))) {
        response.writeHead(scenario === "error" ? 400 : 503, {
          "content-type": "application/json",
          "retry-after-ms": "1",
        })
        response.end(JSON.stringify({ error: { message: "fixture failure", type: "invalid_request_error" } }))
        return
      }
      const tool = primary && scenario === "tool-stop"
      const delta = tool
        ? {
            tool_calls: [
              { index: 0, id: "call_finish", type: "function", function: { name: "finish_turn", arguments: "{}" } },
            ],
          }
        : { content: "No memory updates." }
      const finish = tool ? "tool_calls" : primary && scenario === "unknown" ? "unknown" : "stop"
      const chunk = (delta: object, finish_reason: string | null, usage?: object) =>
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }], usage })}\n\n`
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end(
        chunk(delta, null) +
          chunk({}, finish, { prompt_tokens: 20_000, completion_tokens: 5, total_tokens: 20_005 }) +
          "data: [DONE]\n\n",
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          model: "alibaba-cn/qwen-plus",
          small_model: "alibaba-cn/qwen-flash",
          enabled_providers: ["alibaba-cn"],
          provider: {
            "alibaba-cn": {
              options: { apiKey: "fake", baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` },
            },
          },
          memory: {
            auto_extract: "always",
            auto_recall: false,
            session_memory: true,
            auto_dream: true,
            dream_min_hours: 0.0001,
            dream_min_sessions: 1,
          },
          compaction: { auto: false },
          lsp: false,
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await ToolRegistry.register({
            id: "finish_turn",
            init: async () => ({
              description: "Finish this turn",
              parameters: z.object({}),
              execute: async () => ({ title: "Finished", output: "Finished", metadata: {}, stop: true }),
            }),
          })
          await Session.create({ title: "Earlier conversation" })
          const parent = scenario === "child" ? await Session.create({ title: "Parent" }) : undefined
          const session = await Session.create({
            title: "Completion fixture",
            ...(parent ? { parentID: parent.id } : {}),
          })
          const running = Loop.prompt({
            sessionID: session.id,
            permissionMode: "auto",
            parts: [{ type: "text", text: "completion-case" }],
          }).then(
            (value) => ({ value, error: undefined }),
            (error: unknown) => ({ value: undefined, error }),
          )
          if (scenario === "cancel") {
            await started.promise
            await Loop.cancelTree(session.id)
          }
          const result = await running
          if (scenario === "cancel") expect(result.error).toMatchObject({ name: "MessageAbortedError" })
          else {
            expect(result.error).toBeUndefined()
            if (scenario === "error") expect(result.value).toMatchObject({ info: { error: expect.any(Object) } })
          }
          await MemoryExtract.drain()
          await SessionMemory.drain()
          await AutoDream.drain()
          const children = await Session.children(session.id)
          expect(children.map((child) => child.title).sort()).toEqual(
            scenario === "error" || scenario === "cancel" || scenario === "child"
              ? []
              : ["memory consolidation", "memory extraction", "session memory"],
          )
          if (scenario === "tool-stop") {
            expect(result.value?.info).toMatchObject({ finish: "stop" })
            expect(result.value?.parts).toContainEqual(
              expect.objectContaining({
                type: "tool",
                tool: "finish_turn",
                state: expect.objectContaining({ status: "completed" }),
              }),
            )
          }
          expect(rootRequests).toBe(scenario === "retry" ? 2 : 1)
        },
      })
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 30_000)
}
