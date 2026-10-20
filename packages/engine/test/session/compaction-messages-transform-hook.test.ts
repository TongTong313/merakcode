import { afterEach, beforeEach, describe, expect, test, type Mock, vi } from "vitest"
import { Identifier } from "@merakcode/util/id"
import { Instance } from "@merakcode/engine/project/instance"
import { Session } from "@merakcode/engine/session/index"
import { SessionCompaction } from "@merakcode/engine/session/compaction"
import { LLM } from "@merakcode/engine/session/llm"
import { Plugin } from "@merakcode/engine/plugin/index"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"

/**
 * experimental.compaction.messages.transform is the last filter before the compaction summary is sampled. Like
 * compaction-permission-mode.test.ts, LLM.stream is mocked to capture the messages actually sent to the summary model,
 * proving the hook sits on the real seam after redactSensitiveToolOutputs and before toModelMessages.
 */

const stream = LLM.stream
let capturedMessages: unknown[] = []

beforeEach(async () => {
  Log.init({ print: false })
  capturedMessages = []
  LLM.stream = (async (input: Parameters<typeof LLM.stream>[0]) => {
    capturedMessages = input.messages
    return {
      fullStream: (async function* () {
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
    } as unknown as Awaited<ReturnType<typeof LLM.stream>>
  }) as typeof LLM.stream
})

afterEach(() => {
  LLM.stream = stream
})

let spy: Mock<typeof Plugin.trigger> | undefined
afterEach(() => {
  spy?.mockRestore()
  spy = undefined
})

const providerConfig = {
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
      options: { apiKey: "test-key" },
    },
  },
}

async function runCompaction(directory: string, toolOutput: string, filePath = "README.md") {
  const session = await Session.create({})
  const model = { providerID: "test-provider", modelID: "test-model" }
  const user = await Session.updateInfo({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID: session.id,
    agent: "build",
    model,
    time: { created: Date.now() },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: user.id,
    sessionID: session.id,
    type: "text",
    text: "帮我读一下这个文件",
  })
  const assistant = await Session.updateInfo({
    id: Identifier.ascending("message"),
    role: "assistant",
    sessionID: session.id,
    parentID: user.id,
    mode: "build",
    agent: "build",
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: model.modelID,
    providerID: model.providerID,
    time: { created: Date.now() },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: assistant.id,
    sessionID: session.id,
    type: "tool",
    callID: "call-1",
    tool: "read",
    state: {
      status: "completed",
      input: { filePath },
      output: toolOutput,
      title: "read",
      metadata: {},
      time: { start: Date.now(), end: Date.now() },
    },
  })

  await SessionCompaction.create({
    sessionID: session.id,
    agent: "build",
    model,
    permissionMode: "ask",
    auto: false,
  })
  const before = await Session.messages({ sessionID: session.id })
  const compaction = before.find((msg) => msg.parts.some((part) => part.type === "compaction"))
  if (compaction?.info.role !== "user") throw new Error("expected compaction user message")
  await SessionCompaction.process({
    parentID: compaction.info.id,
    messages: before,
    sessionID: session.id,
    abort: new AbortController().signal,
    auto: false,
  })
}

describe("experimental.compaction.messages.transform", () => {
  test("messages sent to the summary model carry the content a plugin rewrote in the hook", async () => {
    spy = vi.spyOn(Plugin, "trigger").mockImplementation((async (name: string, _input: unknown, output: unknown) => {
      if (name === "experimental.compaction.messages.transform") {
        const typed = output as { messages: { parts: { type: string; state?: { output: string } }[] }[] }
        for (const message of typed.messages) {
          for (const part of message.parts) {
            if (part.type === "tool" && part.state?.output === "普通文件内容") {
              part.state.output = "[插件改写后的占位内容]"
            }
          }
        }
      }
      return output
    }) as typeof Plugin.trigger)

    await using tmp = await tmpdir({ git: true, config: providerConfig })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => runCompaction(tmp.path, "普通文件内容"),
    })

    const serialized = JSON.stringify(capturedMessages)
    expect(serialized).toContain("插件改写后的占位内容")
    expect(serialized).not.toContain("普通文件内容")
  })

  test("messages sent to the summary model are unchanged when no plugin registers the hook", async () => {
    await using tmp = await tmpdir({ git: true, config: providerConfig })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => runCompaction(tmp.path, "普通文件内容"),
    })

    const serialized = JSON.stringify(capturedMessages)
    expect(serialized).toContain("普通文件内容")
  })

  // Redacting tool output for sensitive paths belongs to plugins, not the engine. Only "unredacted when no plugin
  // handles it" proves that redaction comes from the plugin.
  describe("sensitive path tool output redaction is decided by plugins", () => {
    const SENSITIVE_FILE = "auth.json"
    const TOOL_OUTPUT = "凭据文件的明文内容"

    test("engine does not redact sensitive path tool output when no plugin handles it", async () => {
      spy = vi.spyOn(Plugin, "trigger").mockImplementation((async (_n: string, _i: unknown, output: unknown) => {
        return output
      }) as typeof Plugin.trigger)

      await using tmp = await tmpdir({ git: true, config: providerConfig })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => runCompaction(tmp.path, TOOL_OUTPUT, SENSITIVE_FILE),
      })

      expect(JSON.stringify(capturedMessages)).toContain(TOOL_OUTPUT)
    })
  })
})
