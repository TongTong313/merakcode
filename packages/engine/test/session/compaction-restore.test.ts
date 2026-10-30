/**
 * After auto-compaction, the continuation user message carries synthetic text parts restoring todos, the plan, recent
 * files and invoked skills, and the continuation instruction part comes after them (larger id).
 */
import { afterEach, beforeEach, expect, test } from "vitest"
import path from "path"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"
import { LLM } from "@merakcode/engine/agent/model/llm"
import { Filesystem } from "@merakcode/util/filesystem"

Log.init({ print: false })

const stream = LLM.stream

// The compaction agent emits a summary and stops.
beforeEach(async () => {
  LLM.stream = async () =>
    ({
      stream: (async function* () {
        yield { type: "text-start" }
        yield { type: "text-delta", text: "## Goal\ntest\n## Current Work\nreading file\n## Next Step\nedit file" }
        yield { type: "text-end" }
        yield {
          type: "finish-step",
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          providerMetadata: {},
        }
        yield { type: "finish" }
      })(),
    }) as unknown as Awaited<ReturnType<typeof LLM.stream>>
})

afterEach(() => {
  LLM.stream = stream
})

test("auto-compaction continuation restores todos, plan, files and skills, with the instruction last", async () => {
  const { Identifier } = await import("@merakcode/util/id")
  const { Instance } = await import("@merakcode/engine/infra/project/instance")
  const { Session } = await import("@merakcode/engine/agent/session/index")
  const { SessionCompaction } = await import("@merakcode/engine/agent/context/compaction")
  const { Todo } = await import("@merakcode/engine/agent/session/todo")
  const { FileTime } = await import("@merakcode/engine/infra/file/time")
  const { ulid } = await import("ulid")

  await using tmp = await tmpdir({
    git: true,
    config: {
      provider: {
        "test-provider": {
          name: "Test Provider",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: {
            "test-model": { name: "Test Model", tool_call: true, limit: { context: 128000, output: 4096 } },
          },
          options: { apiKey: "test-key" },
        },
      },
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const model = { providerID: "test-provider", modelID: "test-model" }

      await Todo.update({
        sessionID: session.id,
        todos: [
          { id: "t1", content: "实现压缩续接", status: "in_progress", priority: "high" },
          { id: "t2", content: "写测试", status: "pending", priority: "medium" },
        ],
      })

      // Plan mode is on by default.
      const planPath = Session.plan(session)
      await Filesystem.write(planPath, "# 计划\n1. 步骤一\n2. 步骤二\n")

      const filePath = path.join(tmp.path, "src.ts")
      await Filesystem.write(filePath, "export const x = 1\n")
      FileTime.read(session.id, filePath)

      // A past skill call that loaded a skill.
      const original = await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID: session.id,
        agent: "build",
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
      const assistantInfo = await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "assistant",
        sessionID: session.id,
        agent: "build",
        mode: "build",
        parentID: original.id,
        modelID: "test-model",
        providerID: "test-provider",
        path: { cwd: tmp.path, root: tmp.path },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: assistantInfo.id,
        sessionID: session.id,
        type: "tool",
        tool: "skill",
        callID: ulid(),
        state: {
          status: "completed",
          input: { name: "loop" },
          output: '<skill_content name="loop">...</skill_content>',
          title: "",
          metadata: {},
          time: { start: Date.now(), end: Date.now() },
        },
      })

      await SessionCompaction.create({
        sessionID: session.id,
        agent: "build",
        model,
        permissionMode: "ask",
        auto: true,
      })
      const before = await Session.messages({ sessionID: session.id })
      const compaction = before.find((m) => m.parts.some((p) => p.type === "compaction"))!

      await SessionCompaction.process({
        parentID: compaction.info.id,
        messages: before,
        sessionID: session.id,
        abort: new AbortController().signal,
        auto: true,
      })

      // The continuation user message carries the synthetic continuation instruction.
      const after = await Session.messages({ sessionID: session.id })
      const continuation = after.find(
        (m) =>
          m.info.role === "user" &&
          m.parts.some(
            (p) => p.type === "text" && p.synthetic && p.text.includes("auto-compacted due to context limit"),
          ),
      )!
      expect(continuation).toBeDefined()

      const textParts = continuation.parts.filter((p) => p.type === "text").sort((a, b) => (a.id > b.id ? 1 : -1)) as {
        id: string
        text: string
      }[]
      const joined = textParts.map((p) => p.text).join("\n")

      expect(joined).toContain("Unfinished todos restored after compaction")
      expect(joined).toContain("实现压缩续接")
      expect(joined).toContain("写测试")
      expect(joined).toContain("Current plan file")
      expect(joined).toContain("步骤一")
      expect(joined).toContain("Called the Read tool")
      expect(joined).toContain("export const x = 1")
      expect(joined).toContain('<skill_content name="loop">')

      // The continuation instruction comes after every restored part (largest id).
      const last = textParts[textParts.length - 1]!
      expect(last.text).toContain("auto-compacted due to context limit")
      expect(last.text).toContain("Do not stop to ask the user")
    },
  })
})

test("continuation holds only the instruction when there is nothing to restore", async () => {
  const { Identifier } = await import("@merakcode/util/id")
  const { Instance } = await import("@merakcode/engine/infra/project/instance")
  const { Session } = await import("@merakcode/engine/agent/session/index")
  const { SessionCompaction } = await import("@merakcode/engine/agent/context/compaction")

  await using tmp = await tmpdir({
    git: true,
    config: {
      provider: {
        "test-provider": {
          name: "Test Provider",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: {
            "test-model": { name: "Test Model", tool_call: true, limit: { context: 128000, output: 4096 } },
          },
          options: { apiKey: "test-key" },
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
        model,
        time: { created: Date.now() },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: original.id,
        sessionID: session.id,
        type: "text",
        text: "hello",
      })

      await SessionCompaction.create({
        sessionID: session.id,
        agent: "build",
        model,
        permissionMode: "ask",
        auto: true,
      })
      const before = await Session.messages({ sessionID: session.id })
      const compaction = before.find((m) => m.parts.some((p) => p.type === "compaction"))!

      await SessionCompaction.process({
        parentID: compaction.info.id,
        messages: before,
        sessionID: session.id,
        abort: new AbortController().signal,
        auto: true,
      })

      const after = await Session.messages({ sessionID: session.id })
      const continuation = after.find(
        (m) =>
          m.info.role === "user" &&
          m.parts.some(
            (p) => p.type === "text" && p.synthetic && p.text.includes("auto-compacted due to context limit"),
          ),
      )!
      const textParts = continuation.parts.filter((p) => p.type === "text") as { id: string; text: string }[]
      expect(textParts.length).toBe(1)
      expect(textParts[0]!.text).toContain("auto-compacted due to context limit")
    },
  })
})

// The plan-mode-off branch is not covered: the flag is a module-level singleton and can't be flipped between tests
// in one process.

const TEST_CONFIG = {
  provider: {
    "test-provider": {
      name: "Test Provider",
      npm: "@ai-sdk/openai-compatible",
      env: [],
      models: {
        "test-model": { name: "Test Model", tool_call: true, limit: { context: 128000, output: 4096 } },
      },
      options: { apiKey: "test-key" },
    },
  },
}

/**
 * Creates a user text message, runs auto-compaction, and returns the continuation message's text parts (sorted by id)
 * and their joined text. beforeCompact can add history (e.g. skill call parts) to the user message `originalID`.
 */
async function runCompaction(input: {
  sessionID: string
  model: { providerID: string; modelID: string }
  userText?: string
  beforeCompact?: (ctx: { originalID: string }) => Promise<void>
}): Promise<{ joined: string; textParts: { id: string; text: string }[] }> {
  const { Identifier } = await import("@merakcode/util/id")
  const { Session } = await import("@merakcode/engine/agent/session/index")
  const { SessionCompaction } = await import("@merakcode/engine/agent/context/compaction")

  const original = await Session.updateInfo({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID: input.sessionID,
    agent: "build",
    model: input.model,
    time: { created: Date.now() },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: original.id,
    sessionID: input.sessionID,
    type: "text",
    text: input.userText ?? "do work",
  })
  await input.beforeCompact?.({ originalID: original.id })

  await SessionCompaction.create({
    sessionID: input.sessionID,
    agent: "build",
    model: input.model,
    permissionMode: "ask",
    auto: true,
  })
  const before = await Session.messages({ sessionID: input.sessionID })
  const compaction = before.find((m) => m.parts.some((p) => p.type === "compaction"))!
  await SessionCompaction.process({
    parentID: compaction.info.id,
    messages: before,
    sessionID: input.sessionID,
    abort: new AbortController().signal,
    auto: true,
  })

  const after = await Session.messages({ sessionID: input.sessionID })
  const continuation = after.find(
    (m) =>
      m.info.role === "user" &&
      m.parts.some((p) => p.type === "text" && p.synthetic && p.text.includes("auto-compacted due to context limit")),
  )!
  const textParts = continuation.parts.filter((p) => p.type === "text").sort((a, b) => (a.id > b.id ? 1 : -1)) as {
    id: string
    text: string
  }[]
  return { joined: textParts.map((p) => p.text).join("\n"), textParts }
}

test("recent file restore skips instruction files such as CLAUDE.md", async () => {
  const { Instance } = await import("@merakcode/engine/infra/project/instance")
  const { Session } = await import("@merakcode/engine/agent/session/index")
  const { FileTime } = await import("@merakcode/engine/infra/file/time")
  const { tmpdir } = await import("../fixture/fixture")

  await using tmp = await tmpdir({ config: TEST_CONFIG })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const model = { providerID: "test-provider", modelID: "test-model" }

      const srcPath = path.join(tmp.path, "src.ts")
      await Filesystem.write(srcPath, "export const x = 1\n")
      // InstructionPrompt already injects instruction files every turn, so restore must skip them.
      const claudePath = path.join(tmp.path, "CLAUDE.md")
      await Filesystem.write(claudePath, "# CLAUDE\nunique-instr-marker-xyz\n")
      FileTime.read(session.id, srcPath)
      FileTime.read(session.id, claudePath)

      const { joined } = await runCompaction({ sessionID: session.id, model })

      expect(joined).toContain("export const x = 1")
      expect(joined).not.toContain("unique-instr-marker-xyz")
    },
  })
})

test("file over the token budget is truncated with FILE_TRUNCATION_MARKER", async () => {
  const { Instance } = await import("@merakcode/engine/infra/project/instance")
  const { Session } = await import("@merakcode/engine/agent/session/index")
  const { FileTime } = await import("@merakcode/engine/infra/file/time")
  const { tmpdir } = await import("../fixture/fixture")

  await using tmp = await tmpdir({ config: TEST_CONFIG })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const model = { providerID: "test-provider", modelID: "test-model" }

      // 1500 lines x 15 chars; ReadTool output with line-number prefixes is ~36k chars, above the 20000-char
      // (5000 tokens x 4) per-file restore budget, but under ReadTool's own 2000-line and 51200-byte limits, so only
      // compaction-restore truncates it.
      const bigPath = path.join(tmp.path, "big.ts")
      await Filesystem.write(bigPath, Array.from({ length: 1500 }, () => "a".repeat(15)).join("\n"))
      FileTime.read(session.id, bigPath)

      const { joined } = await runCompaction({ sessionID: session.id, model })

      expect(joined).toContain(
        "[... file content truncated due to compaction-restore budget; use the Read tool to re-read the file]",
      )
    },
  })
})

test("skill called several times is restored only once", async () => {
  const { Instance } = await import("@merakcode/engine/infra/project/instance")
  const { Session } = await import("@merakcode/engine/agent/session/index")
  const { Identifier } = await import("@merakcode/util/id")
  const { ulid } = await import("ulid")
  const { tmpdir } = await import("../fixture/fixture")

  await using tmp = await tmpdir({ config: TEST_CONFIG })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const model = { providerID: "test-provider", modelID: "test-model" }

      const { joined } = await runCompaction({
        sessionID: session.id,
        model,
        beforeCompact: async ({ originalID }) => {
          // Two completed calls to the same skill.
          for (let i = 0; i < 2; i++) {
            await Session.updatePart({
              id: Identifier.ascending("part"),
              messageID: originalID,
              sessionID: session.id,
              type: "tool",
              tool: "skill",
              callID: ulid(),
              state: {
                status: "completed",
                input: { name: "loop" },
                output: '<skill_content name="loop">...</skill_content>',
                title: "",
                metadata: {},
                time: { start: Date.now(), end: Date.now() },
              },
            })
          }
        },
      })

      const count = (joined.match(/<skill_content name="loop">/g) ?? []).length
      expect(count).toBe(1)
    },
  })
})

test("todo restore keeps only unfinished items, dropping completed and cancelled", async () => {
  const { Instance } = await import("@merakcode/engine/infra/project/instance")
  const { Session } = await import("@merakcode/engine/agent/session/index")
  const { Todo } = await import("@merakcode/engine/agent/session/todo")
  const { tmpdir } = await import("../fixture/fixture")

  await using tmp = await tmpdir({ config: TEST_CONFIG })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const model = { providerID: "test-provider", modelID: "test-model" }

      await Todo.update({
        sessionID: session.id,
        todos: [
          { id: "t1", content: "进行中项-应恢复", status: "in_progress", priority: "high" },
          { id: "t2", content: "已完成项-勿恢复", status: "completed", priority: "medium" },
          { id: "t3", content: "已取消项-勿恢复", status: "cancelled", priority: "low" },
        ],
      })

      const { joined } = await runCompaction({ sessionID: session.id, model })

      expect(joined).toContain("进行中项-应恢复")
      expect(joined).not.toContain("已完成项-勿恢复")
      expect(joined).not.toContain("已取消项-勿恢复")
    },
  })
})
