import { afterEach, describe, expect, test } from "vitest"
import { Instance } from "@merakcode/engine/project/instance"
import { Session } from "@merakcode/engine/session/index"
import { Storage } from "@merakcode/engine/storage/storage"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

/**
 * Invariant: ws_ containers are created by Project.forWorkspace, not fromDirectory, so migrateFromGlobal never pulls
 * single-folder history from the global bucket into a workspace. This test fails if containers switch to fromDirectory.
 */
describe("Workspace container and migrateFromGlobal", () => {
  afterEach(async () => {
    await Instance.disposeAll().catch(() => undefined)
  })

  test("opening a multi-root workspace does not move same-directory sessions from the global bucket into ws_", async () => {
    await using a = await tmpdir()
    await using b = await tmpdir({ git: true })

    const globalSession = await Instance.provide({
      directory: a.path,
      fn: () => Session.create({ title: "stay-in-global" }),
    })
    expect(globalSession.projectID).toBe("global")
    await Instance.disposeAll()

    const folders = [{ path: a.path }, { path: b.path }]
    const wsIDs = await Instance.provide({
      directory: a.path,
      workspace: { folders },
      fn: async () => {
        expect(Instance.project.id.startsWith("ws_")).toBe(true)
        const ids: string[] = []
        for await (const s of Session.list()) ids.push(s.id)
        return { ids, projectID: Instance.project.id }
      },
    })
    expect(wsIDs.ids).not.toContain(globalSession.id)

    const still = await Storage.read(["session", "global", globalSession.id]).catch(() => undefined)
    expect(still).toBeDefined()
    expect((still as { id: string }).id).toBe(globalSession.id)

    await Instance.provide({
      directory: a.path,
      fn: () => Session.remove(globalSession.id),
    }).catch(() => undefined)
  })
})
