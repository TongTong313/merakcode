import { describe, expect, test } from "vitest"
import fs from "fs/promises"
import path from "path"
import { Identifier } from "@merakcode/util/id"
import { Instance } from "@merakcode/engine/project/instance"
import { Session } from "@merakcode/engine/session/index"
import { Message } from "@merakcode/engine/session/message"
import { Transcript } from "@merakcode/engine/session/transcript"
import { Storage } from "@merakcode/engine/storage/storage"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

Log.init({ print: false })

/**
 * JSONL session storage. Assertions check both the raw lines on disk (the format rules are followed) and the replayed
 * result (callers see the same semantics as the previous per-file storage).
 */

async function lines(sessionID: string) {
  const text = await Filesystem.readText(Transcript.file(sessionID))
  return text
    .split("\n")
    .filter(Boolean)
    .map((raw) => JSON.parse(raw))
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

describe("write and replay", () => {
  test(
    "message snapshots merge by ID, keeping stored values for omitted fields; every line has time and version",
    within(async () => {
      const session = await Session.create({})
      const info = await Session.updateInfo(user(session.id))
      await Transcript.update(session.id, info.id, (prev) => ({ ...prev!, permissionMode: "auto" }) as Message.Info)
      await Session.updateInfo({ ...info, metadata: { tag: "x" } })

      const read = await Message.get({ sessionID: session.id, messageID: info.id })
      expect(read.info.metadata).toEqual({ tag: "x" })
      expect((read.info as Message.UserInfo).permissionMode).toBe("auto")

      const written = await lines(session.id)
      expect(written.map((line) => line.type)).toEqual(["message", "message", "message"])
      for (const line of written) {
        expect(typeof line.time).toBe("number")
        expect(typeof line.version).toBe("string")
      }
    }),
  )

  test(
    "streamed text is readable in-process without hitting disk and is written when the assistant message completes",
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

      expect((await lines(session.id)).map((line) => line.type)).toEqual(["message", "message"])
      expect(await Message.parts({ sessionID: session.id, messageID: reply.id })).toEqual([
        { ...part, text: "你好，世界" },
      ])

      await Session.updateInfo({ ...reply, time: { created: reply.time.created, completed: Date.now() } })
      const written = await lines(session.id)
      expect(written.map((line) => line.type)).toEqual(["message", "message", "part", "message"])
      expect(written[2].part.text).toBe("你好，世界")
    }),
  )

  test(
    "1000 running updates of a tool write one line, and the final state writes one more",
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
      const count = async () => (await lines(session.id)).filter((line) => line.type === "part").length
      await Session.updatePart(tool)
      await Session.updatePart({
        ...tool,
        state: { status: "pending", input: { command: "ls" }, raw: '{"command":"ls"' },
      })
      expect(await count()).toBe(1)

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
      expect(await count()).toBe(2)
      // In-process reads see the latest progress, not the first copy written to disk.
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
      expect(await count()).toBe(3)
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
    "returned objects are detached from the cache, so caller mutations don't affect later reads",
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
    "torn tail lines and unknown record types are skipped, and the first append adds a newline after a torn line",
    within(async () => {
      const session = await Session.create({})
      const info = user(session.id)
      const file = Transcript.file(session.id)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await Filesystem.write(
        file,
        [
          JSON.stringify({ type: "message", time: 1, version: "1.3.9", info }),
          JSON.stringify({ type: "future-kind", time: 1, version: "9.9.9", payload: 1 }),
          '{"type":"part","time":1,"part":{"id":"prt_torn',
        ].join("\n"),
      )

      const part = await Session.updatePart(text(session.id, info.id, "after"))
      const read = await Message.get({ sessionID: session.id, messageID: info.id })
      expect(read.info.id).toBe(info.id)
      expect(read.parts.map((p) => p.id)).toEqual([part.id])

      const raw = (await Filesystem.readText(file)).split("\n")
      expect(raw.at(-2)).toSatisfy((value: string) => value.startsWith('{"type":"part"'))
      expect(raw.at(-2)).toContain('"after"')
    }),
  )

  test(
    "lines appended by another process are visible to this process",
    within(async () => {
      const session = await Session.create({})
      const info = await Session.updateInfo(user(session.id))
      expect(await Message.parts({ sessionID: session.id, messageID: info.id })).toEqual([])

      const part = text(session.id, info.id, "来自别的进程")
      await fs.appendFile(
        Transcript.file(session.id),
        JSON.stringify({ type: "part", time: 1, version: "x", part }) + "\n",
      )
      expect(await Message.parts({ sessionID: session.id, messageID: info.id })).toEqual([part])
    }),
  )

  test(
    "concurrent reads of one session apply delta lines once and advance the read offset once",
    within(async () => {
      const session = await Session.create({})
      const info = await Session.updateInfo(user(session.id))
      const part = await Session.updatePart(text(session.id, info.id, "起"))
      // Read once to fill the cache, then have "another process" append two legacy-format delta lines (found in
      // files written before this format); the concurrent reads must all parse from the same offset.
      await Message.parts({ sessionID: session.id, messageID: info.id })
      const tail = ["承", "转"]
        .map((delta) =>
          JSON.stringify({
            type: "delta",
            time: 1,
            version: "x",
            messageID: info.id,
            partID: part.id,
            field: "text",
            delta,
          }),
        )
        .join("\n")
      await fs.appendFile(Transcript.file(session.id), tail + "\n")

      const reads = await Promise.all(
        Array.from({ length: 4 }, () => Message.parts({ sessionID: session.id, messageID: info.id })),
      )
      for (const read of reads) expect((read[0] as Message.TextPart).text).toBe("起承转")

      await fs.appendFile(
        Transcript.file(session.id),
        JSON.stringify({
          type: "delta",
          time: 1,
          version: "x",
          messageID: info.id,
          partID: part.id,
          field: "text",
          delta: "合",
        }) + "\n",
      )
      expect(((await Message.parts({ sessionID: session.id, messageID: info.id }))[0] as Message.TextPart).text).toBe(
        "起承转合",
      )
    }),
  )

  test(
    "concurrent transcript creation for one session lets one win; the other returns false without overwriting",
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
