import { afterEach, describe, expect, test } from "vitest"
import { FileWatcher } from "@merakcode/engine/agent/workspace/file/watcher"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Filesystem } from "@merakcode/util/filesystem"
import { tmpdir } from "../fixture/fixture"

/**
 * In multi-root each folder may be its own repo. Watching must start if any root is a git repo, not be skipped because
 * the primary is not one; otherwise changes in the second root never reach the UI.
 */
describe("FileWatcher.vcsRoots multi-root", () => {
  afterEach(async () => {
    await Instance.disposeAll().catch(() => undefined)
  })

  test("watches the second root when it is git and the primary is not", async () => {
    await using a = await tmpdir()
    await using b = await tmpdir({ git: true })
    await Instance.provide({
      directory: a.path,
      workspace: {
        folders: [
          { name: "alpha", path: a.path },
          { name: "beta", path: b.path },
        ],
      },
      fn: () => {
        const roots = FileWatcher.vcsRoots(Instance.workspace)
        expect(roots).toHaveLength(1)
        expect(Filesystem.sameDirectory(roots[0]!, b.path)).toBe(true)
      },
    })
  })

  test("deduplicates roots that share a worktree", async () => {
    await using repo = await tmpdir({ git: true })
    await Instance.provide({
      directory: repo.path,
      workspace: {
        folders: [
          { name: "root", path: repo.path },
          { name: "same", path: repo.path },
        ],
      },
      fn: () => {
        expect(FileWatcher.vcsRoots(Instance.workspace)).toHaveLength(1)
      },
    })
  })

  test("returns nothing when no root is a git repo", async () => {
    await using a = await tmpdir()
    await using b = await tmpdir()
    await Instance.provide({
      directory: a.path,
      workspace: {
        folders: [
          { name: "alpha", path: a.path },
          { name: "beta", path: b.path },
        ],
      },
      fn: () => {
        expect(FileWatcher.vcsRoots(Instance.workspace)).toHaveLength(0)
      },
    })
  })

  test("single-root git repo still returns its own worktree", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        const roots = FileWatcher.vcsRoots(Instance.workspace)
        expect(roots).toHaveLength(1)
        expect(Filesystem.sameDirectory(roots[0]!, tmp.path)).toBe(true)
      },
    })
  })
})
