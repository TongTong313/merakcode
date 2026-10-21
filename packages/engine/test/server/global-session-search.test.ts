import { afterEach, describe, expect, test } from "vitest"
import { Instance } from "@merakcode/engine/project/instance"
import { Server } from "@merakcode/engine/server/server"
import { Session } from "@merakcode/engine/session/index"
import { Database } from "@merakcode/engine/storage/db"
import { Storage } from "@merakcode/engine/storage/storage"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll().catch(() => undefined)
})

describe("global.session.search", () => {
  test("searches sessions across persisted projects even when workspaces are closed", async () => {
    await using first = await tmpdir({ git: true })
    await using second = await tmpdir({ git: true })

    const firstSession = await Instance.provide({
      directory: first.path,
      fn: () => Session.create({ title: "alpha-root" }),
    })
    const secondSession = await Instance.provide({
      directory: second.path,
      fn: () => Session.create({ title: "beta-root" }),
    })
    const childSession = await Instance.provide({
      directory: second.path,
      fn: () => Session.create({ title: "beta-child", parentID: secondSession.id }),
    })

    const app = Server.App()
    const response = await app.request(
      `/global/session/search?search=${encodeURIComponent("beta")}&roots=true&limit=30`,
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as Array<{ id: string }>
    const ids = body.map((session) => session.id)
    expect(ids).toContain(secondSession.id)
    expect(ids).not.toContain(firstSession.id)
    expect(ids).not.toContain(childSession.id)
  })

  test("includes child sessions when roots filtering is not requested", async () => {
    await using tmp = await tmpdir({ git: true })

    const root = await Instance.provide({
      directory: tmp.path,
      fn: () => Session.create({ title: "root-search" }),
    })
    const child = await Instance.provide({
      directory: tmp.path,
      fn: () => Session.create({ title: "root-search-child", parentID: root.id }),
    })

    const app = Server.App()
    const response = await app.request(`/global/session/search?search=${encodeURIComponent("root-search")}`)

    expect(response.status).toBe(200)
    const body = (await response.json()) as Array<{ id: string }>
    const ids = body.map((session) => session.id)
    expect(ids).toContain(root.id)
    expect(ids).toContain(child.id)
  })

  test("skips a damaged session record without losing other results", async () => {
    await using tmp = await tmpdir({ git: true })

    const session = await Instance.provide({
      directory: tmp.path,
      fn: () => Session.create({ title: "survives-corruption" }),
    })
    Database.query("INSERT INTO session (id, project_id, title, updated, data) VALUES (?, ?, ?, ?, ?)").run(
      "ses_damaged",
      session.projectID,
      "survives-damaged",
      Date.now(),
      "{not-json",
    )

    const app = Server.App()
    const response = await app.request(`/global/session/search?search=${encodeURIComponent("survives")}`)

    expect(response.status).toBe(200)
    const body = (await response.json()) as Array<{ id: string }>
    expect(body.map((item) => item.id)).toEqual([session.id])
  })

  test("finds sessions even when project metadata is missing", async () => {
    await using tmp = await tmpdir({ git: true })

    const session = await Instance.provide({
      directory: tmp.path,
      fn: () => Session.create({ title: "orphan-project-session" }),
    })
    await Storage.remove(["project", session.projectID])

    const app = Server.App()
    const response = await app.request(`/global/session/search?search=${encodeURIComponent("orphan-project")}`)

    expect(response.status).toBe(200)
    const body = (await response.json()) as Array<{ id: string }>
    expect(body.some((item) => item.id === session.id)).toBe(true)
  })
})
