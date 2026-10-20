// Engine integration tests for citing past conversations (#Past Chats): create real sessions and messages, render
// them as injectable context, and run the full createUserMessage expansion via SessionRunner.prompt({ noReply })
// without calling the LLM.
import path from "path"
import { describe, expect, test } from "vitest"
import { Session } from "@merakcode/engine/session/index"
import { SessionReference } from "@merakcode/engine/session/reference"
import { SessionRunner } from "@merakcode/engine/session/runner"
import { Message } from "@merakcode/engine/session/message"
import { Identifier } from "@merakcode/util/id"
import { Instance } from "@merakcode/engine/project/instance"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"
import { Config } from "../../src/config/config"

Log.init({ print: false })

const MODEL = { providerID: "openai", modelID: "gpt-4" }

/** Writes one real turn: user text, assistant text, and optional extra assistant parts. */
async function turn(sessionID: string, user: string, assistant: string, extra?: Message.Part[]) {
  const userMsg = await Session.updateInfo({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID,
    agent: "default",
    model: MODEL,
    time: { created: Date.now() },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: userMsg.id,
    sessionID,
    type: "text",
    text: user,
  })

  const assistantMsg = await Session.updateInfo({
    id: Identifier.ascending("message"),
    role: "assistant",
    sessionID,
    parentID: userMsg.id,
    mode: "default",
    agent: "default",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: MODEL.modelID,
    providerID: MODEL.providerID,
    time: { created: Date.now(), completed: Date.now() },
    finish: "end_turn",
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: assistantMsg.id,
    sessionID,
    type: "text",
    text: assistant,
  })
  for (const part of extra ?? []) {
    await Session.updatePart({ ...part, messageID: assistantMsg.id, sessionID })
  }
  return { userMsg, assistantMsg }
}

describe("SessionReference.render", () => {
  test("renders both sides of the conversation with the session id and title", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "鉴权改造讨论" })
        await turn(session.id, "鉴权中间件怎么拆", "先把 token 校验独立出来")

        const result = await SessionReference.render(session.id)

        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.title).toBe("鉴权改造讨论")
        expect(result.text).toContain(session.id)
        expect(result.text).toContain("鉴权改造讨论")
        expect(result.text).toContain("鉴权中间件怎么拆")
        expect(result.text).toContain("先把 token 校验独立出来")
      },
    })
  })

  test("omits reasoning and tool input/output, the main sources of context blowup", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "带工具的对话" })
        await turn(session.id, "读一下配置", "配置里端口是 4096", [
          {
            id: Identifier.ascending("part"),
            messageID: "",
            sessionID: "",
            type: "reasoning",
            text: "我应该先看 config.ts 里的默认值",
            time: { start: Date.now(), end: Date.now() },
          },
          {
            id: Identifier.ascending("part"),
            messageID: "",
            sessionID: "",
            type: "tool",
            callID: "call_1",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "/repo/secret-config.ts" },
              output: "PORT=4096\nTOKEN=must-not-leak-into-context",
              title: "read",
              metadata: {},
              time: { start: Date.now(), end: Date.now() },
            },
          },
        ])

        const result = await SessionReference.render(session.id)

        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.text).not.toContain("我应该先看 config.ts")
        expect(result.text).not.toContain("must-not-leak-into-context")
        expect(result.text).not.toContain("/repo/secret-config.ts")
        // Tool names stay as a cheap signal of what was done.
        expect(result.text).toContain("read")
      },
    })
  })

  test("does not re-inject synthetic text such as @file previews or recalled memory", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "带注入的对话" })
        const { userMsg } = await turn(session.id, "看看这个文件", "看完了")
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: userMsg.id,
          sessionID: session.id,
          type: "text",
          synthetic: true,
          text: "SYNTHETIC-PRELOADED-FILE-CONTENT",
        })

        const result = await SessionReference.render(session.id)

        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.text).not.toContain("SYNTHETIC-PRELOADED-FILE-CONTENT")
        expect(result.text).toContain("看看这个文件")
      },
    })
  })

  test("truncates with a notice when over budget instead of dropping everything", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "长对话" })
        await turn(session.id, "第一个问题", "第一个回答")
        await turn(session.id, "第二个问题", "第二个回答".repeat(200))

        const result = await SessionReference.render(session.id, { maxBytes: 80 })

        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.text).toContain("长对话")
        expect(result.text).toContain(SessionReference.TRUNCATED_MARK)
        expect(result.text).toContain("第二个问题")
        expect(result.text).not.toContain("第一个问题")
      },
    })
  })

  test("missing session returns ok:false instead of throwing and failing the whole prompt", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const missing = await SessionReference.render("ses_doesNotExist")
        expect(missing.ok).toBe(false)

        // An id with an invalid prefix (client typo) doesn't throw either.
        const malformed = await SessionReference.render("not-an-id")
        expect(malformed.ok).toBe(false)
      },
    })
  })

  test("session with the default title shows a placeholder, not the ISO timestamp", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await turn(session.id, "问", "答")

        const result = await SessionReference.render(session.id)

        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.text).not.toContain("New session - ")
      },
    })
  })
})

// The client's forkCutoff passes the messageID where the next turn starts, and the engine copies ids < messageID.
// Forking at turn N must keep the user messages and replies of the first N turns; a user reported only the first
// turn surviving.
describe("Session.fork copy range across turns", () => {
  /** All non-synthetic text in the session, oldest first. */
  async function texts(sessionID: string) {
    const msgs = await Session.messages({ sessionID })
    return msgs.flatMap((msg) =>
      msg.parts
        .filter((part): part is Extract<Message.Part, { type: "text" }> => part.type === "text" && !part.synthetic)
        .map((part) => `${msg.info.role}:${part.text}`),
    )
  }

  test("forking at the second turn keeps the first two turns and drops the third", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "多轮" })
        await turn(session.id, "问题一", "回答一")
        const second = await turn(session.id, "问题二", "回答二")
        const third = await turn(session.id, "问题三", "回答三")
        void second

        // At the second turn, forkCutoff returns the third turn's user message id as the exclusive upper bound.
        const forked = await Session.fork({ sessionID: session.id, messageID: third.userMsg.id })

        expect(await texts(forked.id)).toEqual(["user:问题一", "assistant:回答一", "user:问题二", "assistant:回答二"])
      },
    })
  })

  test("forking at the last turn without messageID keeps the whole history", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "多轮" })
        await turn(session.id, "问题一", "回答一")
        await turn(session.id, "问题二", "回答二")

        const forked = await Session.fork({ sessionID: session.id })

        expect(await texts(forked.id)).toEqual(["user:问题一", "assistant:回答一", "user:问题二", "assistant:回答二"])
      },
    })
  })

  test("copied assistant.parentID points to a user in the fork, never to a source session id", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "parentID" })
        const first = await turn(session.id, "问题一", "回答一")
        const ghostParent = Identifier.ascending("message")
        const orphan = await Session.updateInfo({
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID: session.id,
          parentID: ghostParent,
          mode: "default",
          agent: "default",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: MODEL.modelID,
          providerID: MODEL.providerID,
          time: { created: Date.now(), completed: Date.now() },
          finish: "end_turn",
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: orphan.id,
          sessionID: session.id,
          type: "text",
          text: "游离回复",
        })

        const sourceIDs = new Set([first.userMsg.id, first.assistantMsg.id, ghostParent, orphan.id])
        const forked = await Session.fork({ sessionID: session.id })
        const copied = await Session.messages({ sessionID: forked.id })
        const userIDs = new Set(copied.filter((m) => m.info.role === "user").map((m) => m.info.id))

        expect(copied.some((m) => m.info.role === "assistant")).toBe(true)
        for (const msg of copied) {
          expect(sourceIDs.has(msg.info.id)).toBe(false)
          if (msg.info.role !== "assistant") continue
          expect(sourceIDs.has(msg.info.parentID)).toBe(false)
          expect(userIDs.has(msg.info.parentID)).toBe(true)
        }
      },
    })
  })

  test("fork of 60 messages pages the latest 50 first and returns the earlier 10 on a wider read", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "分页" })
        for (let i = 1; i <= 30; i++) await turn(session.id, `问题${i}`, `回答${i}`)

        const forked = await Session.fork({ sessionID: session.id })
        const page = await Session.messages({ sessionID: forked.id, limit: 50 })
        expect(page).toHaveLength(50)
        expect(await texts(forked.id)).toHaveLength(60)
        expect(
          page.flatMap((msg) =>
            msg.parts
              .filter((part): part is Extract<Message.Part, { type: "text" }> => part.type === "text")
              .map((part) => `${msg.info.role}:${part.text}`),
          ),
        ).toEqual([...Array.from({ length: 25 }, (_, i) => [`user:问题${i + 6}`, `assistant:回答${i + 6}`]).flat()])

        const wider = await Session.messages({ sessionID: forked.id, limit: 100 })
        expect(wider).toHaveLength(60)
        expect(`${wider[0]?.info.role}:${(wider[0]?.parts[0] as { text?: string } | undefined)?.text}`).toBe(
          "user:问题1",
        )
      },
    })
  })

  test("after copying 20 messages the first page holds all 20", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "短对话" })
        for (let i = 1; i <= 10; i++) await turn(session.id, `问${i}`, `答${i}`)

        const forked = await Session.fork({ sessionID: session.id })
        const page = await Session.messages({ sessionID: forked.id, limit: 50 })
        expect(page).toHaveLength(20)
      },
    })
  })

  test("source session is unchanged and the fork is a sibling without parentID", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "多轮" })
        await turn(session.id, "问题一", "回答一")
        const second = await turn(session.id, "问题二", "回答二")

        const forked = await Session.fork({ sessionID: session.id, messageID: second.userMsg.id })

        expect(forked.parentID).toBeUndefined()
        expect(await texts(session.id)).toEqual(["user:问题一", "assistant:回答一", "user:问题二", "assistant:回答二"])
      },
    })
  })
})

/** createUserMessage resolves a model, so write a minimal provider config (same as prompt-special-chars.test.ts). */
async function writeModelConfig(dir: string) {
  await Filesystem.write(
    path.join(dir, "merakcode.json"),
    JSON.stringify({
      $schema: Config.SCHEMA,
      model: "custom-provider/custom-model",
      provider: {
        "custom-provider": {
          name: "Custom Provider",
          npm: "@ai-sdk/openai-compatible",
          api: "https://api.custom.com/v1",
          options: { apiKey: "test-key" },
          models: { "custom-model": { id: "custom-model", name: "Custom Model", tool_call: true } },
        },
      },
    }),
  )
}

describe("session:// file part expansion (#Past Chats end to end)", () => {
  test("citing a past session adds its transcript as synthetic text and keeps the pointer part", async () => {
    await using tmp = await tmpdir({ git: true, init: writeModelConfig })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const past = await Session.create({ title: "上周的排查" })
        await turn(past.id, "为什么打包变慢了", "因为 sourcemap 开了 full")

        const current = await Session.create({ title: "本次任务" })
        const message = await SessionRunner.prompt({
          sessionID: current.id,
          noReply: true,
          parts: [
            { type: "text", text: "接着上次的结论继续" },
            { type: "file", mime: SessionReference.MIME, url: `session://${past.id}`, filename: "上周的排查" },
          ],
        })

        const stored = await Message.get({ sessionID: current.id, messageID: message.info.id })
        const texts = stored.parts.filter((part) => part.type === "text")

        // The transcript is injected as synthetic text: collapsible in the UI but still sent to the model.
        const injected = texts.find((part) => part.text.includes("为什么打包变慢了"))
        expect(injected).toBeDefined()
        expect(injected?.synthetic).toBe(true)
        expect(injected?.text).toContain("因为 sourcemap 开了 full")
        expect(injected?.text).toContain(past.id)

        // The user's own text is kept alongside the injected content.
        expect(texts.some((part) => part.text === "接着上次的结论继续")).toBe(true)

        // The client rebuilds the citation chip from the pointer part.
        const pointer = stored.parts.find((part) => part.type === "file")
        expect(pointer?.url).toBe(`session://${past.id}`)
        expect(pointer?.mime).toBe(SessionReference.MIME)
      },
    })
  })

  test("citing a missing session injects an error notice without aborting the turn", async () => {
    await using tmp = await tmpdir({ git: true, init: writeModelConfig })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const current = await Session.create({ title: "本次任务" })
        const message = await SessionRunner.prompt({
          sessionID: current.id,
          noReply: true,
          parts: [
            { type: "text", text: "引用一个已删除的对话" },
            { type: "file", mime: SessionReference.MIME, url: "session://ses_goneForever" },
          ],
        })

        const stored = await Message.get({ sessionID: current.id, messageID: message.info.id })
        const texts = stored.parts.filter((part) => part.type === "text")
        expect(texts.some((part) => part.text.includes("Could not cite the past conversation"))).toBe(true)
        expect(texts.some((part) => part.text === "引用一个已删除的对话")).toBe(true)
      },
    })
  })

  // Only guards that the session: branch doesn't hijack file:, by asserting the file: branch is still taken (the
  // Read call notice is the first text it writes). The file content is deliberately not asserted: that depends on
  // whether the provider loads, which fails independently (see prompt-special-chars.test.ts).
  test("session: scheme does not hijack file: expansion of @file mentions", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await writeModelConfig(dir)
        await Filesystem.write(path.join(dir, "note.txt"), "hello\n")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const current = await Session.create({})
        const parts = await SessionRunner.resolvePromptParts("看 @note.txt")
        expect(parts.filter((part) => part.type === "file")).toHaveLength(1)

        const message = await SessionRunner.prompt({ sessionID: current.id, noReply: true, parts })
        const stored = await Message.get({ sessionID: current.id, messageID: message.info.id })
        const texts = stored.parts.filter((part) => part.type === "text")

        expect(texts.some((part) => part.text.includes("Called the Read tool"))).toBe(true)
        // The past-session branch was not taken.
        expect(texts.some((part) => part.text.includes("Referenced an earlier conversation"))).toBe(false)
        expect(texts.some((part) => part.text.includes("Could not cite the past conversation"))).toBe(false)
      },
    })
  })
})
