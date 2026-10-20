import { afterEach, describe, expect, test } from "vitest"
import fs from "fs/promises"
import { Bus } from "@merakcode/engine/bus/index"
import { Identifier } from "@merakcode/util/id"
import { Instance } from "@merakcode/engine/project/instance"
import { Server } from "@merakcode/engine/server/server"
import { Session } from "@merakcode/engine/session/index"
import { Storage } from "@merakcode/engine/storage/storage"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll().catch(() => undefined)
})

describe("missing or corrupt session files", () => {
  for (const kind of ["invalid_json", "invalid_data", "io"] as const) {
    test(`${kind} is a read failure, preserves the session, and recovers after the file is restored`, async () => {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({ title: "read-error-regression" })
          const key = ["session", session.projectID, session.id]
          const target = await Storage.targetPath(key)
          const original = await Filesystem.readText(target)
          const deleted: string[] = []
          const unsubscribe = Bus.subscribe(Session.Event.Deleted, (event) => {
            deleted.push(event.properties.info.id)
          })
          const app = Server.App()
          const url = `http://localhost/session/${session.id}?directory=${encodeURIComponent(tmp.path)}`
          try {
            if (kind === "invalid_json") await Filesystem.write(target, '{"private-marker":')
            if (kind === "invalid_data") await Filesystem.write(target, "null")
            if (kind === "io") {
              await fs.unlink(target)
              await fs.mkdir(target)
            }
            const failure = { name: "SessionReadError", data: { sessionID: session.id, reason: kind } }
            await expect(Session.get(session.id)).rejects.toMatchObject(failure)
            await expect(Session.getByProject({ id: session.id, projectID: session.projectID })).rejects.toMatchObject(
              failure,
            )
            await expect(Session.updateByProject(session.id, session.projectID, () => {})).rejects.toMatchObject(
              failure,
            )
            for (const method of ["GET", "PATCH", "DELETE"]) {
              const response = await app.request(url, {
                method,
                ...(method === "PATCH"
                  ? {
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ title: "must not overwrite unreadable session" }),
                    }
                  : {}),
              })
              expect(response.status).toBe(500)
              const body = await response.json()
              expect(body).toMatchObject(failure)
              expect(JSON.stringify(body)).not.toContain("private-marker")
              expect(JSON.stringify(body)).not.toContain(target)
            }
            expect(deleted).toEqual([])
          } finally {
            unsubscribe()
            if (kind === "io") await fs.rmdir(target)
            await Filesystem.write(target, original)
          }
          expect((await Session.get(session.id)).title).toBe(session.title)
          expect((await app.request(url)).status).toBe(200)
        },
      })
    })
  }

  test("list omits a deleted json, a renamed file, and corrupt json without 500", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const deleted = await Session.create({ title: "deleted-session" })
        const renamed = await Session.create({ title: "renamed-session" })
        const corrupt = await Session.create({ title: "corrupt-session" })
        const intact = await Session.create({ title: "intact-session" })

        const deletedPath = await Storage.targetPath(["session", deleted.projectID, deleted.id])
        const renamedPath = await Storage.targetPath(["session", renamed.projectID, renamed.id])
        const corruptPath = await Storage.targetPath(["session", corrupt.projectID, corrupt.id])

        await fs.unlink(deletedPath)
        await fs.rename(renamedPath, renamedPath.replace(/\.json$/, ".bak.json"))
        await Filesystem.write(corruptPath, "{not-json")

        const app = Server.App()
        const response = await app.request(`http://localhost/session?directory=${encodeURIComponent(tmp.path)}`)
        expect(response.status).toBe(200)
        const ids = ((await response.json()) as Array<{ id: string }>).map((session) => session.id)
        expect(ids).not.toContain(deleted.id)
        expect(ids).not.toContain(renamed.id)
        expect(ids).not.toContain(corrupt.id)
        expect(ids).toContain(intact.id)

        expect(await Filesystem.isFile(renamedPath.replace(/\.json$/, ".bak.json"))).toBe(true)
      },
    })
  })

  test("DELETE of a missing file returns 200 and publishes session.deleted", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "to-delete-file" })
        const target = await Storage.targetPath(["session", session.projectID, session.id])
        await fs.unlink(target)
        const deleted: string[] = []
        const unsubscribe = Bus.subscribe(Session.Event.Deleted, (event) => {
          deleted.push(event.properties.info.id)
        })

        try {
          const response = await Server.App().request(
            `http://localhost/session/${session.id}?directory=${encodeURIComponent(tmp.path)}`,
            { method: "DELETE" },
          )
          expect(response.status).toBe(200)
          expect(await response.json()).toBe(true)
          expect(deleted).toEqual([session.id])
        } finally {
          unsubscribe()
        }
      },
    })
  })

  test("GET, PATCH, messages, prompt, and prompt_async return 404 without publishing session.deleted when the file is gone", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "gone" })
        const target = await Storage.targetPath(["session", session.projectID, session.id])
        await fs.unlink(target)
        const deleted: string[] = []
        const unsubscribe = Bus.subscribe(Session.Event.Deleted, (event) => {
          deleted.push(event.properties.info.id)
        })
        const app = Server.App()
        const dir = encodeURIComponent(tmp.path)
        const promptBody = JSON.stringify({
          parts: [{ type: "text", text: "hello" }],
        })

        try {
          const get = await app.request(`http://localhost/session/${session.id}?directory=${dir}`)
          expect(get.status).toBe(404)

          const patch = await app.request(`http://localhost/session/${session.id}?directory=${dir}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "nope" }),
          })
          expect(patch.status).toBe(404)

          const messages = await app.request(`http://localhost/session/${session.id}/message?directory=${dir}`)
          expect(messages.status).toBe(404)

          const prompt = await app.request(`http://localhost/session/${session.id}/message?directory=${dir}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: promptBody,
          })
          expect(prompt.status).toBe(404)
          expect(await prompt.json()).toMatchObject({ name: "NotFoundError" })

          const promptAsync = await app.request(
            `http://localhost/session/${session.id}/prompt_async?directory=${dir}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: promptBody,
            },
          )
          expect(promptAsync.status).toBe(404)

          expect(deleted).toEqual([])
        } finally {
          unsubscribe()
        }
      },
    })
  })

  test("GET of a never-created valid id returns 404 without publishing session.deleted", async () => {
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
          )
          expect(response.status).toBe(404)
          expect(deleted).toEqual([])
        } finally {
          unsubscribe()
        }
      },
    })
  })
})
