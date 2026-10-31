import { describe, expect, test } from "vitest"
import path from "path"
import { unlink } from "fs/promises"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Rule } from "@merakcode/engine/agent/prompt/rules/rule"
import { RuleManage } from "@merakcode/engine/agent/prompt/rules/manage"
import { tmpdir } from "../fixture/fixture"
import { isolate, nativeRule } from "./isolate"
import { Filesystem } from "@merakcode/util/filesystem"

function nativeFiles(snapshot: Awaited<ReturnType<typeof RuleManage.read>>) {
  return snapshot.files.filter((file) => file.kind === "native")
}

describe("RuleManage.read", () => {
  test("drops cached rules whose files were deleted on disk and invalidates injection cache", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: (dir) => nativeRule(dir, "gone.mdc", "alwaysApply: true"),
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect((await Rule.all()).map((r) => r.name)).toEqual(["gone"])
          await unlink(path.join(tmp.path, ".merakcode", "rules", "gone.mdc"))
          expect((await Rule.all()).map((r) => r.name)).toEqual(["gone"])

          const snapshot = await RuleManage.read()
          expect(nativeFiles(snapshot).map((f) => f.name)).toEqual([])
          expect(await Rule.all()).toEqual([])
        },
      })
    })
  })
})

describe("RuleManage.change file_delete", () => {
  test("deletes an existing project rule", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: (dir) => nativeRule(dir, "keep.mdc", "alwaysApply: true"),
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const filepath = path.join(tmp.path, ".merakcode", "rules", "keep.mdc")
          const result = await RuleManage.change({ type: "file_delete", filepath })
          expect(result.ok).toBe(true)
          if (result.ok) expect(nativeFiles(result.snapshot).map((f) => f.name)).toEqual([])
          expect(await Filesystem.isFile(filepath)).toBe(false)
        },
      })
    })
  })

  test("treats a disk-deleted rule as already gone (idempotent, not a permission error)", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await nativeRule(dir, "keep.mdc", "alwaysApply: true")
          await nativeRule(dir, "gone.mdc", "alwaysApply: true")
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect((await Rule.all()).map((r) => r.name).sort()).toEqual(["gone", "keep"])
          const gone = path.join(tmp.path, ".merakcode", "rules", "gone.mdc")
          await unlink(gone)
          expect((await Rule.all()).map((r) => r.name).sort()).toEqual(["gone", "keep"])

          const result = await RuleManage.change({ type: "file_delete", filepath: gone })
          expect(result.ok).toBe(true)
          if (result.ok) expect(nativeFiles(result.snapshot).map((f) => f.name)).toEqual(["keep"])
          expect((await Rule.all()).map((r) => r.name)).toEqual(["keep"])
        },
      })
    })
  })

  test("deleting the same rule twice succeeds", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: (dir) => nativeRule(dir, "once.mdc", "alwaysApply: true"),
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const filepath = path.join(tmp.path, ".merakcode", "rules", "once.mdc")
          const first = await RuleManage.change({ type: "file_delete", filepath })
          expect(first.ok).toBe(true)
          const second = await RuleManage.change({ type: "file_delete", filepath })
          expect(second.ok).toBe(true)
          if (second.ok) expect(nativeFiles(second.snapshot).map((f) => f.name)).toEqual([])
        },
      })
    })
  })
})
