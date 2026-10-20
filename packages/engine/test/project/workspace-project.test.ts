import { afterEach, describe, expect, test } from "vitest"
import { Instance } from "@merakcode/engine/project/instance"
import { Workspace } from "@merakcode/engine/project/workspace"
import { Filesystem } from "@merakcode/util/filesystem"
import { tmpdir } from "../fixture/fixture"

describe("Instance.project workspace container", () => {
  afterEach(async () => {
    await Instance.disposeAll().catch(() => undefined)
  })

  test("multi-root provide yields a virtual ws_ project with worktree and vcs from the primary root", async () => {
    await using a = await tmpdir({ git: true })
    await using b = await tmpdir({ git: true })

    let primaryID = ""
    await Instance.provide({
      directory: a.path,
      fn: () => {
        primaryID = Instance.project.id
        expect(primaryID).not.toBe("global")
        expect(Instance.project.kind).toBeUndefined()
      },
    })
    await Instance.disposeAll()

    await Instance.provide({
      directory: a.path,
      workspace: {
        folders: [
          { name: "alpha", path: a.path },
          { name: "beta", path: b.path },
        ],
      },
      fn: () => {
        const identity = Workspace.identity({
          directory: a.path,
          folders: [
            { name: "alpha", path: a.path },
            { name: "beta", path: b.path },
          ],
        })
        expect(identity).toBeDefined()
        expect(Instance.project.id).toBe(identity!.id)
        expect(Instance.project.id.startsWith("ws_")).toBe(true)
        expect(Instance.project.id).not.toBe(primaryID)
        expect(Instance.project.kind).toBe("workspace")
        expect(Instance.project.worktree).toBe(Filesystem.normalize(a.path))
        expect(Instance.project.vcs).toBe("git")
        expect(Instance.project.folders).toEqual([Filesystem.normalize(a.path), Filesystem.normalize(b.path)])
        expect(Instance.worktree).toBe(Filesystem.normalize(a.path))
      },
    })
  })

  test("single-root provide creates no workspace container (CLI contract)", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        expect(Instance.project.id.startsWith("ws_")).toBe(false)
        expect(Instance.project.kind).toBeUndefined()
        expect(Instance.project.folders).toBeUndefined()
      },
    })
  })
})
