import { afterEach, beforeEach, expect, test } from "vitest"
import { LLM } from "@merakcode/engine/session/llm"

const stream = LLM.stream

beforeEach(async () => {
  LLM.stream = async () =>
    ({
      stream: (async function* () {
        yield { type: "text-start" }
        yield { type: "text-delta", text: "summary" }
        yield { type: "text-end" }
        yield {
          type: "finish-step",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          providerMetadata: {},
        }
        yield { type: "finish" }
      })(),
    }) as unknown as Awaited<ReturnType<typeof LLM.stream>>
})

afterEach(() => {
  LLM.stream = stream
})

test("continuation user message after auto-compaction inherits the permissionMode from before compaction", async () => {
  const { Identifier } = await import("@merakcode/util/id")
  const { Instance } = await import("@merakcode/engine/project/instance")
  const { Session } = await import("@merakcode/engine/session/index")
  const { SessionCompaction } = await import("@merakcode/engine/session/compaction")
  const { Log } = await import("@merakcode/log/logger")
  const { tmpdir } = await import("../fixture/fixture")

  Log.init({ print: false })

  await using tmp = await tmpdir({
    config: {
      provider: {
        "test-provider": {
          name: "Test Provider",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: {
            "test-model": {
              name: "Test Model",
              tool_call: true,
              limit: { context: 128000, output: 4096 },
            },
          },
          options: {
            apiKey: "test-key",
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const model = { providerID: "test-provider", modelID: "test-model" }
      const original = await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID: session.id,
        agent: "build",
        permissionMode: "auto",
        model,
        time: { created: Date.now() },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: original.id,
        sessionID: session.id,
        type: "text",
        text: "do work",
      })
      await SessionCompaction.create({
        sessionID: session.id,
        agent: "build",
        model,
        permissionMode: "auto",
        auto: true,
      })

      const before = await Session.messages({ sessionID: session.id })
      const compaction = before.find((msg) => msg.parts.some((part) => part.type === "compaction"))
      if (compaction?.info.role !== "user") throw new Error("expected compaction user message")
      expect(compaction.info.permissionMode).toBeUndefined()

      await SessionCompaction.process({
        parentID: compaction.info.id,
        messages: before,
        sessionID: session.id,
        abort: new AbortController().signal,
        auto: true,
      })

      const after = await Session.messages({ sessionID: session.id })
      const continuation = after.find((msg) =>
        msg.parts.some(
          (part) => part.type === "text" && part.synthetic && part.text.includes("auto-compacted due to context limit"),
        ),
      )
      if (continuation?.info.role !== "user") throw new Error("expected continuation user message")
      const part = compaction.parts.find((p) => p.type === "compaction")
      if (!part || part.type !== "compaction") throw new Error("expected compaction part")

      expect(part?.permissionMode).toBe("auto")
      expect(continuation.info.permissionMode).toBe("auto")
    },
  })
})
