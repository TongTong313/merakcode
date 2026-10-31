import { Process } from "@merakcode/util/process"
import { Project } from "@merakcode/engine/infra/project/project"
import { discoverProject } from "@merakcode/engine/app/project/discover"
import { SessionOperations } from "@merakcode/engine/app/session"
import { afterEach, describe, expect, test } from "vitest"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Session } from "@merakcode/engine/agent/session/index"
import { SessionStore } from "@merakcode/engine/agent/session/store"
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
      resolveProject: discoverProject,
      directory: a.path,
      fn: () => Session.create({ title: "stay-in-global" }),
    })
    expect(globalSession.projectID).toBe("global")
    await Instance.disposeAll()

    const folders = [{ path: a.path }, { path: b.path }]
    const wsIDs = await Instance.provide({
      resolveProject: discoverProject,
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

    expect(SessionStore.get("global", globalSession.id)?.id).toBe(globalSession.id)

    await Instance.provide({
      resolveProject: discoverProject,
      directory: a.path,
      fn: () => SessionOperations.remove(globalSession.id),
    }).catch(() => undefined)
  })
})

for (const discovery of ["resource", "application"] as const) {
  test(discovery + " project discovery keeps history migration at the application seam", async () => {
    await using tmp = await tmpdir()
    const session = await Instance.provide({ directory: tmp.path, fn: () => Session.create({ title: "Before Git" }) })
    expect(session.projectID).toBe("global")
    await Instance.disposeAll()
    await Process.run(["git", "init", "--quiet", tmp.path])
    await Process.run(
      [
        "git",
        "-c",
        "user.name=Migration Test",
        "-c",
        "user.email=migration@example.test",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      ],
      { cwd: tmp.path },
    )
    if (discovery === "resource") {
      const { project } = await Project.fromDirectory(tmp.path)
      expect(project.id).not.toBe("global")
      expect(SessionStore.find(session.id)?.projectID).toBe("global")
      await Instance.provide({
        directory: tmp.path,
        resolveProject: discoverProject,
        fn: () => {
          expect(SessionStore.find(session.id)?.projectID).toBe(Instance.project.id)
        },
      })
    } else {
      await Instance.provide({
        directory: tmp.path,
        resolveProject: discoverProject,
        fn: () => {
          expect(Instance.project.id).not.toBe("global")
          expect(SessionStore.find(session.id)?.projectID).toBe(Instance.project.id)
        },
      })
    }
  })
}
