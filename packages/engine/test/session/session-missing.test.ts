import { afterEach, describe, expect, test } from "vitest"
import { Bus } from "@merakcode/engine/infra/bus/index"
import { Identifier } from "@merakcode/util/id"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Server } from "@merakcode/engine/app/server/server"
import { Session } from "@merakcode/engine/agent/session/index"
import { SessionStore } from "@merakcode/engine/agent/session/store"
import { Database } from "@merakcode/engine/infra/storage/db"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll().catch(() => undefined)
})

function damage(sessionID: string, data: string) {
  Database.query("UPDATE session SET data = ? WHERE id = ?").run(data, sessionID)
}

describe("missing or damaged session records", () => {
  for (const data of ['{"private-marker":', "null", JSON.stringify({ id: "ses_other" })]) {
    test(`damaged data ${data} is a read failure, preserves the session, and recovers once restored`, async () => {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({ title: "read-error-regression" })
          const deleted: string[] = []
          const unsubscribe = Bus.subscribe(Session.Event.Deleted, (event) => {
            deleted.push(event.properties.info.id)
          })
          const app = Server.App()
          const url = `http://localhost/session/${session.id}?directory=${encodeURIComponent(tmp.path)}`
          try {
            damage(session.id, data)
            const failure = { name: "SessionReadError", data: { sessionID: session.id, reason: "invalid_data" } }
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
            }
            expect(deleted).toEqual([])
          } finally {
            unsubscribe()
            damage(session.id, JSON.stringify(session))
          }
          expect((await Session.get(session.id)).title).toBe(session.title)
          expect((await app.request(url)).status).toBe(200)
        },
      })
    })
  }

  test("list omits a deleted session and damaged data without 500", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const deleted = await Session.create({ title: "deleted-session" })
        const renamed = await Session.create({ title: "renamed-session" })
        const corrupt = await Session.create({ title: "corrupt-session" })
        const intact = await Session.create({ title: "intact-session" })

        SessionStore.remove(deleted.id)
        damage(renamed.id, JSON.stringify({ ...renamed, id: "ses_other" }))
        damage(corrupt.id, "{not-json")

        const app = Server.App()
        const response = await app.request(`http://localhost/session?directory=${encodeURIComponent(tmp.path)}`)
        expect(response.status).toBe(200)
        const ids = ((await response.json()) as Array<{ id: string }>).map((session) => session.id)
        expect(ids).not.toContain(deleted.id)
        expect(ids).not.toContain(renamed.id)
        expect(ids).not.toContain(corrupt.id)
        expect(ids).toContain(intact.id)
      },
    })
  })

  test("DELETE of a missing session returns 200 and publishes session.deleted", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "to-delete-file" })
        SessionStore.remove(session.id)
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

  test("GET, PATCH, messages, prompt, and prompt_async return 404 without publishing session.deleted when the session is gone", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "gone" })
        SessionStore.remove(session.id)
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
