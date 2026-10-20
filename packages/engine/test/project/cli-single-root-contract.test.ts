import { afterEach, describe, expect, test } from "vitest"
import { Instance } from "@merakcode/engine/project/instance"
import { Session } from "@merakcode/engine/session/index"
import { Filesystem } from "@merakcode/util/filesystem"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

/**
 * CLI/TUI contract: without folders, behavior matches a single working directory. Guards the CLI against desktop
 * multi-root changes leaking in.
 */
describe("CLI single-root contract", () => {
  afterEach(async () => {
    await Instance.disposeAll().catch(() => undefined)
  })

  test("workspace.key equals normalize(directory) and there is no workspace identity", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        expect(Instance.workspace.key).toBe(Filesystem.normalize(tmp.path))
        expect(Instance.workspace.identity).toBeUndefined()
        expect(Instance.workspace.folders).toHaveLength(1)
        expect(Instance.project.kind).toBeUndefined()
        expect(Instance.project.id.startsWith("ws_")).toBe(false)
      },
    })
  })

  test("sessions belong to the git project.id, not a ws_ container", async () => {
    await using tmp = await tmpdir({ git: true })
    const session = await Instance.provide({
      directory: tmp.path,
      fn: () => Session.create({ title: "cli-solo" }),
    })
    try {
      expect(session.projectID.startsWith("ws_")).toBe(false)
      expect(session.projectID).toBe(
        await Instance.provide({
          directory: tmp.path,
          fn: () => Instance.project.id,
        }),
      )
      expect(session.workspaceFolders).toBeUndefined()
    } finally {
      await Instance.provide({
        directory: tmp.path,
        fn: () => Session.remove(session.id),
      }).catch(() => undefined)
    }
  })
})
