import { describe, expect, test } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { Identifier } from "@merakcode/util/id"
import { Instance } from "@merakcode/engine/project/instance"
import { Session } from "@merakcode/engine/session/index"
import { Message } from "@merakcode/engine/session/message"
import { Transcript } from "@merakcode/engine/session/transcript"
import { Database } from "@merakcode/engine/storage/db"
import { Storage } from "@merakcode/engine/storage/storage"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

/**
 * Session content in the message and part tables. Assertions check both the stored rows (what is persisted when) and
 * what callers read back.
 */

function stored(sessionID: string) {
  const rows = (table: string) =>
    (
      Database.query(`SELECT data FROM ${table} WHERE session_id = ? ORDER BY id`).all(sessionID) as { data: string }[]
    ).map((row) => JSON.parse(row.data))
  return { messages: rows("message"), parts: rows("part") }
}

function user(sessionID: string, id = Identifier.ascending("message")): Message.UserInfo {
  return {
    id,
    sessionID,
    role: "user",
    agent: "build",
    model: { providerID: "test", modelID: "test" },
    time: { created: Date.now() },
  }
}

function assistant(sessionID: string, parentID: string): Message.AssistantInfo {
  return {
    id: Identifier.ascending("message"),
    sessionID,
    role: "assistant",
    parentID,
    modelID: "test",
    providerID: "test",
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now() },
  }
}

function text(sessionID: string, messageID: string, value: string): Message.TextPart {
  return { id: Identifier.ascending("part"), sessionID, messageID, type: "text", text: value }
}

function within(fn: () => Promise<void>) {
  return async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({ directory: tmp.path, fn })
  }
}

describe("write and read", () => {
  test(
    "message snapshots merge by ID, keeping stored values for omitted fields",
    within(async () => {
      const session = await Session.create({})
      const info = await Session.updateInfo(user(session.id))
      await Transcript.update(session.id, info.id, (prev) => ({ ...prev!, permissionMode: "auto" }) as Message.Info)
      await Session.updateInfo({ ...info, metadata: { tag: "x" } })

      const read = await Message.get({ sessionID: session.id, messageID: info.id })
      expect(read.info.metadata).toEqual({ tag: "x" })
      expect((read.info as Message.UserInfo).permissionMode).toBe("auto")
      expect(stored(session.id).messages).toMatchObject([
        { id: info.id, permissionMode: "auto", metadata: { tag: "x" } },
      ])
    }),
  )

  test(
    "streamed text is readable in-process without being written and is written when the assistant message completes",
    within(async () => {
      const session = await Session.create({})
      const asked = await Session.updateInfo(user(session.id))
      const reply = assistant(session.id, asked.id)
      await Session.updateInfo(reply)
      const part = text(session.id, reply.id, "")
      for (const chunk of ["你", "好", "，世界"]) {
        part.text += chunk
        await Session.updatePart({ part, delta: chunk })
      }

      expect(stored(session.id).parts).toEqual([])
      expect(await Message.parts({ sessionID: session.id, messageID: reply.id })).toEqual([
        { ...part, text: "你好，世界" },
      ])

      await Session.updateInfo({ ...reply, time: { created: reply.time.created, completed: Date.now() } })
      expect(stored(session.id).parts.map((item) => item.text)).toEqual(["你好，世界"])
    }),
  )

  test(
    "1000 running updates of a tool are not written; only each new state is",
    within(async () => {
      const session = await Session.create({})
      const info = await Session.updateInfo(user(session.id))
      const tool: Message.ToolPart = {
        id: Identifier.ascending("part"),
        sessionID: session.id,
        messageID: info.id,
        type: "tool",
        tool: "bash",
        callID: "call-1",
        state: { status: "pending", input: {}, raw: "" },
      }
      const state = () => stored(session.id).parts[0]?.state
      await Session.updatePart(tool)
      await Session.updatePart({
        ...tool,
        state: { status: "pending", input: { command: "ls" }, raw: '{"command":"ls"' },
      })
      expect(state()).toEqual({ status: "pending", input: {}, raw: "" })

      for (let index = 0; index < 1000; index++)
        await Session.updatePart({
          ...tool,
          state: {
            status: "running",
            input: { command: "ls" },
            metadata: { output: "x".repeat(index) },
            time: { start: 1 },
          },
        })
      expect(state()).toMatchObject({ status: "running", metadata: { output: "" } })
      // In-process reads see the latest progress, not the copy written first.
      const [live] = await Message.parts({ sessionID: session.id, messageID: info.id })
      expect((live as Message.ToolPart).state).toMatchObject({
        status: "running",
        metadata: { output: "x".repeat(999) },
      })

      await Session.updatePart({
        ...tool,
        state: {
          status: "completed",
          input: { command: "ls" },
          output: "ok",
          title: "ls",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      })
      expect(state()).toMatchObject({ status: "completed", output: "ok" })
    }),
  )

  test(
    "removing a part drops only that part, removing a message drops all its parts, and the ID can be reused",
    within(async () => {
      const session = await Session.create({})
      const info = await Session.updateInfo(user(session.id))
      const first = await Session.updatePart(text(session.id, info.id, "a"))
      const second = await Session.updatePart(text(session.id, info.id, "b"))

      await Session.removePart({ sessionID: session.id, messageID: info.id, partID: first.id })
      expect((await Message.parts({ sessionID: session.id, messageID: info.id })).map((p) => p.id)).toEqual([second.id])

      await Session.removeMessage({ sessionID: session.id, messageID: info.id })
      await expect(Message.get({ sessionID: session.id, messageID: info.id })).rejects.toBeInstanceOf(
        Storage.NotFoundError,
      )
      expect(await Message.parts({ sessionID: session.id, messageID: info.id })).toEqual([])
      expect(stored(session.id)).toEqual({ messages: [], parts: [] })

      await Session.updateInfo(info)
      expect((await Message.get({ sessionID: session.id, messageID: info.id })).parts).toEqual([])
    }),
  )

  test(
    "messages and parts are sorted by ID regardless of write order, and stream yields newest first",
    within(async () => {
      const session = await Session.create({})
      const early = user(session.id)
      const late = user(session.id)
      await Session.updateInfo(late)
      await Session.updateInfo(early)
      const a = text(session.id, early.id, "a")
      const b = text(session.id, early.id, "b")
      await Session.updatePart(b)
      await Session.updatePart(a)

      const all = await Session.messages({ sessionID: session.id })
      expect(all.map((m) => m.info.id)).toEqual([early.id, late.id])
      expect(all[0]!.parts.map((p) => p.id)).toEqual([a.id, b.id])
      const newest = await Array.fromAsync(Message.stream(session.id))
      expect(newest.map((m) => m.info.id)).toEqual([late.id, early.id])
    }),
  )

  test(
    "returned objects are detached, so caller mutations don't affect later reads",
    within(async () => {
      const session = await Session.create({})
      const info = await Session.updateInfo(user(session.id))
      await Session.updatePart(text(session.id, info.id, "原文"))

      const first = await Message.get({ sessionID: session.id, messageID: info.id })
      ;(first.parts[0] as Message.TextPart).text = "被调用方改掉"
      const second = await Message.get({ sessionID: session.id, messageID: info.id })
      expect((second.parts[0] as Message.TextPart).text).toBe("原文")
    }),
  )
})

describe("fault tolerance and multiple writers", () => {
  test(
    "a damaged message is skipped and the rest of the session still reads",
    within(async () => {
      const session = await Session.create({})
      const info = await Session.updateInfo(user(session.id))
      const part = await Session.updatePart(text(session.id, info.id, "after"))
      const damaged = await Session.updateInfo(user(session.id))
      Database.query("UPDATE message SET data = ? WHERE session_id = ? AND id = ?").run(
        '{"role":"user",',
        session.id,
        damaged.id,
      )

      const all = await Session.messages({ sessionID: session.id })
      expect(all.map((item) => item.info.id)).toEqual([info.id])
      expect(all[0]!.parts.map((p) => p.id)).toEqual([part.id])
      await expect(Message.get({ sessionID: session.id, messageID: damaged.id })).rejects.toBeInstanceOf(
        Storage.NotFoundError,
      )
    }),
  )

  test(
    "rows written through another connection (another process) are visible at once",
    within(async () => {
      const session = await Session.create({})
      const info = await Session.updateInfo(user(session.id))
      expect(await Message.parts({ sessionID: session.id, messageID: info.id })).toEqual([])

      const part = text(session.id, info.id, "来自别的进程")
      using other = new DatabaseSync(Database.file(), { timeout: 10_000 })
      other
        .prepare("INSERT INTO part (session_id, id, message_id, written, data) VALUES (?, ?, ?, ?, ?)")
        .run(session.id, part.id, info.id, Date.now(), JSON.stringify(part))
      expect(await Message.parts({ sessionID: session.id, messageID: info.id })).toEqual([part])
    }),
  )

  test(
    "concurrent content creation for one session lets one win; the other returns false without overwriting",
    within(async () => {
      const session = await Session.create({})
      const a = user(session.id)
      const b = user(session.id)
      const results = await Promise.all([
        Transcript.create(session.id, [{ type: "message", info: a }]),
        Transcript.create(session.id, [{ type: "message", info: b }]),
      ])
      expect(results.filter(Boolean)).toHaveLength(1)
      const winner = results[0] ? a : b
      expect((await Session.messages({ sessionID: session.id })).map((m) => m.info.id)).toEqual([winner.id])
    }),
  )
})
