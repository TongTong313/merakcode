import { afterEach, describe, expect, test } from "vitest"
import fs from "fs/promises"
import path from "path"
import { Bus } from "@merakcode/engine/bus/index"
import { Global } from "@merakcode/engine/global/index"
import { ReviewBaseline } from "@merakcode/engine/review/baseline"
import { SessionMemoryPath } from "@merakcode/engine/session-memory/path"
import { Identifier } from "@merakcode/util/id"
import { Instance } from "@merakcode/engine/project/instance"
import { Server } from "@merakcode/engine/server/server"
import { Session } from "@merakcode/engine/session/index"
import { Message } from "@merakcode/engine/session/message"
import { Transcript } from "@merakcode/engine/session/transcript"
import { Storage } from "@merakcode/engine/storage/storage"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

Log.init({ print: false })

async function seed(sessionID: string, text: string) {
  const message = await Session.updateInfo({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID,
    agent: "build",
    model: {
      providerID: "test-provider",
      modelID: "test-model",
    },
    time: { created: Date.now() },
  })
  const part = await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: message.id,
    sessionID,
    type: "text",
    text,
  })
  return { message, part }
}

async function seedAssociated(session: Session.Info) {
  const sessionID = session.id
  const keys = [
    ["session_diff", sessionID],
    ["todo", sessionID],
    ["memory_extract", sessionID],
    ["session_notification", sessionID, "notification-test"],
    ["workflow", sessionID, "run-test"],
    ["workflow_run", sessionID, "run-test"],
    ["cron", sessionID, "task-test"],
  ]
  await Promise.all(keys.map((key) => Storage.write(key, { sessionID })))
  ReviewBaseline.put(sessionID, "/file.txt", Buffer.from("accepted"))
  const files = [
    path.join(Global.Path.data, "backup", sessionID, "1", "file.txt"),
    Session.plan(session),
    SessionMemoryPath.file(sessionID),
  ]
  for (const file of files) await Filesystem.write(file, "x")
  return { keys, files }
}

describe("DELETE /session/:sessionID", () => {
  afterEach(async () => {
    await Instance.disposeAll().catch(() => undefined)
  })

  test("permanently deletes a parent session, its children, and their stored messages", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "parent" })
        const child = await Session.create({ parentID: parent.id, title: "child" })
        const parentData = await seed(parent.id, "parent message")
        const childData = await seed(child.id, "child message")
        const associated = [await seedAssociated(parent), await seedAssociated(child)]
        const deleted: string[] = []
        const unsubscribe = Bus.subscribe(Session.Event.Deleted, (event) => {
          deleted.push(event.properties.info.id)
        })

        try {
          const app = Server.App()
          const response = await app.request(
            `http://localhost/session/${parent.id}?directory=${encodeURIComponent(tmp.path)}`,
            { method: "DELETE" },
          )

          expect(response.status).toBe(200)
          expect(await response.json()).toBe(true)
          expect(deleted).toEqual([child.id, parent.id])

          await expect(Session.get(parent.id)).rejects.toBeInstanceOf(Storage.NotFoundError)
          await expect(Session.get(child.id)).rejects.toBeInstanceOf(Storage.NotFoundError)
          for (const [sessionID, data] of [
            [parent.id, parentData],
            [child.id, childData],
          ] as const) {
            await expect(Message.get({ sessionID, messageID: data.message.id })).rejects.toBeInstanceOf(
              Storage.NotFoundError,
            )
            expect(await Message.parts({ sessionID, messageID: data.message.id })).toEqual([])
            expect(Transcript.written(sessionID)).toBe(0)
            expect(ReviewBaseline.all(sessionID).size).toBe(0)
          }
          for (const { keys, files } of associated) {
            for (const key of keys) await expect(Storage.read(key)).rejects.toBeInstanceOf(Storage.NotFoundError)
            for (const file of files) expect(await Filesystem.exists(file)).toBe(false)
          }

          const listResponse = await app.request(`http://localhost/session?directory=${encodeURIComponent(tmp.path)}`)
          expect(listResponse.status).toBe(200)
          const sessions = (await listResponse.json()) as Array<{ id: string }>
          const ids = sessions.map((session) => session.id)
          expect(ids).not.toContain(parent.id)
          expect(ids).not.toContain(child.id)
        } finally {
          unsubscribe()
        }
      },
    })
  })

  test("returns 200 and publishes session.deleted when the session ID is valid but the session is missing", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sessionID = Identifier.ascending("session")
        const deleted: string[] = []
        const unsubscribe = Bus.subscribe(Session.Event.Deleted, (event) => {
          deleted.push(event.properties.info.id)
        })

        try {
          const response = await Server.App().request(
            `http://localhost/session/${sessionID}?directory=${encodeURIComponent(tmp.path)}`,
            { method: "DELETE" },
          )

          expect(response.status).toBe(200)
          expect(await response.json()).toBe(true)
          expect(deleted).toEqual([sessionID])
        } finally {
          unsubscribe()
        }
      },
    })
  })

  test("returns 500 without deleting tree records or publishing events when parent cleanup fails", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "blocked parent delete" })
        const child = await Session.create({ parentID: parent.id, title: "child" })
        // A directory where the plan document goes cannot be removed as a file
        const blocked = Session.plan(parent)
        await fs.mkdir(blocked, { recursive: true })
        const deleted: string[] = []
        const unsubscribe = Bus.subscribe(Session.Event.Deleted, (event) => {
          deleted.push(event.properties.info.id)
        })

        try {
          const response = await Server.App().request(
            `http://localhost/session/${parent.id}?directory=${encodeURIComponent(tmp.path)}`,
            { method: "DELETE" },
          )

          expect(response.status).toBe(500)
          expect((await Session.get(parent.id)).id).toBe(parent.id)
          expect((await Session.get(child.id)).id).toBe(child.id)
          expect(deleted).toEqual([])
        } finally {
          unsubscribe()
          await fs.rm(blocked, { recursive: true, force: true })
          await Session.remove(parent.id)
        }
      },
    })
  })

  test("returns 400 when the session ID is invalid", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await Server.App().request(
          `http://localhost/session/invalid-session-id?directory=${encodeURIComponent(tmp.path)}`,
          { method: "DELETE" },
        )

        expect(response.status).toBe(400)
      },
    })
  })
})
