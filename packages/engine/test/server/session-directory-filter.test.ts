import { SessionOperations } from "@merakcode/engine/app/session"
import { afterEach, describe, expect, test } from "vitest"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Session } from "@merakcode/engine/agent/session/index"
import { Server } from "@merakcode/engine/app/server/server"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

// GET /session filters by directory through Filesystem.sameDirectory. Querying with a spelling that differs literally
// but normalizes to the same directory would miss the session if the route fell back to a plain `===`.
describe("GET /session directory filter (cross-platform path normalization)", () => {
  afterEach(async () => {
    await Instance.disposeAll().catch(() => undefined)
  })

  test("a query with a trailing slash still lists sessions created in that directory", async () => {
    await using tmp = await tmpdir({ git: true })
    const dir = tmp.path
    const created = await Instance.provide({ directory: dir, fn: () => Session.create({ title: "trailing-slash" }) })
    try {
      const app = Server.App()
      const res = await app.request(`http://localhost/session?directory=${encodeURIComponent(dir + "/")}`)
      expect(res.status).toBe(200)
      const list = (await res.json()) as Array<{ id: string }>
      expect(list.some((s) => s.id === created.id)).toBe(true)
    } finally {
      await Instance.provide({ directory: dir, fn: () => SessionOperations.remove(created.id) })
    }
  })

  test("a query for a different subdirectory does not include the session", async () => {
    await using tmp = await tmpdir({ git: true })
    const dir = tmp.path
    const created = await Instance.provide({ directory: dir, fn: () => Session.create({ title: "root-only" }) })
    try {
      const app = Server.App()
      // The subdirectory shares the projectID (same .git) but is a different directory, so it must be excluded
      const res = await app.request(`http://localhost/session?directory=${encodeURIComponent(dir + "/sub")}`)
      expect(res.status).toBe(200)
      const list = (await res.json()) as Array<{ id: string }>
      expect(list.some((s) => s.id === created.id)).toBe(false)
    } finally {
      await Instance.provide({ directory: dir, fn: () => SessionOperations.remove(created.id) })
    }
  })
})
