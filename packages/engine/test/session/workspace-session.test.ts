import { SessionOperations } from "@merakcode/engine/app/session"
import { afterEach, describe, expect, test } from "vitest"
import path from "path"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Session } from "@merakcode/engine/agent/session/index"
import { Server } from "@merakcode/engine/app/server/server"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("Session restore by workspace", () => {
  afterEach(async () => {
    await Instance.disposeAll().catch(() => undefined)
  })

  test("sessions restore in the same workspace and stay hidden from the primary folder opened alone", async () => {
    await using a = await tmpdir({ git: true })
    await using b = await tmpdir({ git: true })
    const folders = [
      { name: "alpha", path: a.path },
      { name: "beta", path: b.path },
    ]

    const wsSession = await Instance.provide({
      directory: a.path,
      workspace: { folders },
      fn: () => Session.create({ title: "in-workspace" }),
    })
    await Instance.disposeAll()

    const soloSession = await Instance.provide({
      directory: a.path,
      fn: () => Session.create({ title: "solo-primary" }),
    })
    await Instance.disposeAll()

    try {
      const wsIDs = await Instance.provide({
        directory: a.path,
        workspace: { folders },
        fn: async () => {
          const ids: string[] = []
          for await (const s of Session.list()) ids.push(s.id)
          return ids
        },
      })
      expect(wsIDs).toContain(wsSession.id)
      expect(wsIDs).not.toContain(soloSession.id)
      expect(wsSession.projectID.startsWith("ws_")).toBe(true)
      expect(soloSession.projectID.startsWith("ws_")).toBe(false)

      await Instance.disposeAll()

      const soloIDs = await Instance.provide({
        directory: a.path,
        fn: async () => {
          const ids: string[] = []
          for await (const s of Session.list()) ids.push(s.id)
          return ids
        },
      })
      expect(soloIDs).toContain(soloSession.id)
      expect(soloIDs).not.toContain(wsSession.id)
    } finally {
      await Instance.provide({
        directory: a.path,
        workspace: { folders },
        fn: () => SessionOperations.remove(wsSession.id),
      }).catch(() => undefined)
      await Instance.disposeAll()
      await Instance.provide({
        directory: a.path,
        fn: () => SessionOperations.remove(soloSession.id),
      }).catch(() => undefined)
    }
  })

  test("GET /session keeps workspace sessions when directory is the new primary", async () => {
    await using a = await tmpdir({ git: true })
    await using b = await tmpdir({ git: true })
    const foldersAB = [
      { name: "alpha", path: a.path },
      { name: "beta", path: b.path },
    ]
    const foldersBA = [
      { name: "beta", path: b.path },
      { name: "alpha", path: a.path },
    ]

    const created = await Instance.provide({
      directory: a.path,
      workspace: { folders: foldersAB },
      fn: () => Session.create({ title: "reorder-primary" }),
    })
    // session.directory records the primary at creation time (a).
    expect(created.directory).toContain(path.basename(a.path))
    await Instance.disposeAll()

    try {
      const app = Server.App()
      // After reordering the primary is b, so query directory=b; identity comes from the folder set, not its order.
      const res = await app.request(`http://localhost/session?directory=${encodeURIComponent(b.path)}`, {
        headers: {
          "x-merakcode-directory": encodeURIComponent(b.path),
          "x-merakcode-workspace-folders": encodeURIComponent(JSON.stringify(foldersBA)),
        },
      })
      expect(res.status).toBe(200)
      const list = (await res.json()) as Array<{ id: string }>
      expect(list.some((s) => s.id === created.id)).toBe(true)
    } finally {
      await Instance.provide({
        directory: a.path,
        workspace: { folders: foldersAB },
        fn: () => SessionOperations.remove(created.id),
      }).catch(() => undefined)
    }
  })
})
