import { describe, expect, test } from "vitest"
import { snapshotToPatch, snapshotToVcsDiff } from "../../src/cli/cmd/tui/routes/diff/patch"
import type { FileDiff as SnapshotFileDiff } from "@merakcode/sdk/client"

describe("snapshotToPatch", () => {
  test("converts before/after into a unified patch", () => {
    const item: SnapshotFileDiff = {
      file: "test.ts",
      before: "hello\n",
      after: "hello\nworld\n",
      additions: 1,
      deletions: 0,
    }
    const patch = snapshotToPatch(item)
    expect(patch).toContain("test.ts")
    expect(patch).toContain("+world")
    expect(patch).toContain("@@")
  })

  test("handles a newly added file", () => {
    const item: SnapshotFileDiff = {
      file: "new.ts",
      before: "",
      after: "console.log('hi')\n",
      additions: 1,
      deletions: 0,
    }
    const patch = snapshotToPatch(item)
    expect(patch).toContain("new.ts")
    expect(patch).toContain("+console.log")
  })

  test("handles a deleted file", () => {
    const item: SnapshotFileDiff = {
      file: "old.ts",
      before: "console.log('bye')\n",
      after: "",
      additions: 0,
      deletions: 1,
    }
    const patch = snapshotToPatch(item)
    expect(patch).toContain("old.ts")
    expect(patch).toContain("-console.log")
  })

  test("handles an empty file", () => {
    const item: SnapshotFileDiff = {
      file: "empty.ts",
      before: "",
      after: "",
      additions: 0,
      deletions: 0,
    }
    const patch = snapshotToPatch(item)
    // Still produces a patch, empty because nothing changed
    expect(typeof patch).toBe("string")
  })
})

describe("snapshotToVcsDiff", () => {
  test("converts a session diff into a VCS diff", () => {
    const item: SnapshotFileDiff = {
      file: "src/utils.ts",
      before: "export const x = 1\n",
      after: "export const x = 2\n",
      additions: 1,
      deletions: 1,
    }
    const result = snapshotToVcsDiff(item)
    expect(result.file).toBe("src/utils.ts")
    expect(result.additions).toBe(1)
    expect(result.deletions).toBe(1)
    expect(result.status).toBe("modified")
    expect(result.patch).toContain("src/utils.ts")
    expect(result.patch).toContain("+export const x = 2")
    expect(result.patch).toContain("-export const x = 1")
  })

  test("keeps the original status", () => {
    const item: SnapshotFileDiff = {
      file: "added.ts",
      before: "",
      after: "new\n",
      additions: 1,
      deletions: 0,
      status: "added",
    }
    expect(snapshotToVcsDiff(item).status).toBe("added")

    const deleted: SnapshotFileDiff = {
      file: "gone.ts",
      before: "old\n",
      after: "",
      additions: 0,
      deletions: 1,
      status: "deleted",
    }
    expect(snapshotToVcsDiff(deleted).status).toBe("deleted")
  })

  test("defaults to modified without a status", () => {
    const item: SnapshotFileDiff = {
      file: "test.ts",
      before: "",
      after: "",
      additions: 0,
      deletions: 0,
    }
    expect(snapshotToVcsDiff(item).status).toBe("modified")
  })

  test("handles Chinese file names", () => {
    const item: SnapshotFileDiff = {
      file: "src/中文文件.ts",
      before: "旧内容\n",
      after: "新内容\n",
      additions: 1,
      deletions: 1,
    }
    const result = snapshotToVcsDiff(item)
    expect(result.file).toBe("src/中文文件.ts")
    expect(result.patch).toContain("src/中文文件.ts")
  })

  test("handles multi-line before/after", () => {
    const item: SnapshotFileDiff = {
      file: "multi.ts",
      before: "line1\nline2\nline3\n",
      after: "line1\nline2-modified\nline3\nline4\n",
      additions: 2,
      deletions: 1,
    }
    const result = snapshotToVcsDiff(item)
    expect(result.additions).toBe(2)
    expect(result.deletions).toBe(1)
    expect(result.patch).toContain("+line2-modified")
    expect(result.patch).toContain("-line2")
  })
})
