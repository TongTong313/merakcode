import { describe, expect, test } from "vitest"
import { collectRenderedHunks, logicalHunkRows, pickRelativeHunk } from "../../src/cli/cmd/tui/routes/diff/diff-hunk"

describe("logicalHunkRows", () => {
  test("accumulates hunk start rows by rendered line (excluding @@ lines)", () => {
    const rows = logicalHunkRows("@@ -1 +1 @@\n+b")
    expect(rows).toEqual([0])
  })

  test("accumulates row numbers across multiple hunks", () => {
    const patch = `diff --git a/f b/f
--- a/f
+++ b/f
@@ -1,1 +1,2 @@
 a
+b
@@ -3,1 +3,2 @@
 c
+d
`
    expect(logicalHunkRows(patch)).toEqual([0, 2])
  })

  test("returns nothing without hunks", () => {
    expect(logicalHunkRows("+only addition")).toEqual([])
  })
})

describe("collectRenderedHunks", () => {
  test("computes contentY from hunkRows", () => {
    const hunks = collectRenderedHunks([{ fileIndex: 0, baseContentY: 10, hunkRows: [0, 5] }])
    expect(hunks).toEqual([
      { fileIndex: 0, hunkIndex: 0, contentY: 10 },
      { fileIndex: 0, hunkIndex: 1, contentY: 15 },
    ])
  })

  test("falls back to parsing the patch without hunkRows", () => {
    const hunks = collectRenderedHunks([{ fileIndex: 0, baseContentY: 5, patch: "@@ -1 +1 @@\n+b" }])
    expect(hunks).toEqual([{ fileIndex: 0, hunkIndex: 0, contentY: 5 }])
  })

  test("sorts multiple files by contentY", () => {
    const hunks = collectRenderedHunks([
      { fileIndex: 1, baseContentY: 100, hunkRows: [0] },
      { fileIndex: 0, baseContentY: 5, hunkRows: [0] },
    ])
    expect(hunks.map((h) => h.fileIndex)).toEqual([0, 1])
  })
})

describe("pickRelativeHunk", () => {
  const hunks = [
    { fileIndex: 0, hunkIndex: 0, contentY: 10 },
    { fileIndex: 0, hunkIndex: 1, contentY: 20 },
    { fileIndex: 1, hunkIndex: 0, contentY: 50 },
  ]

  test("moves by offset from the selected hunk", () => {
    const selected = { fileIndex: 0, hunkIndex: 0, scrollTop: 10 }
    expect(pickRelativeHunk(hunks, 10, selected, 1)).toEqual(hunks[1])
    expect(pickRelativeHunk(hunks, 10, selected, -1)).toBeUndefined()
  })

  test("without a selection, infers the hunk from the scroll position", () => {
    expect(pickRelativeHunk(hunks, 5, undefined, 1)).toEqual(hunks[0])
    expect(pickRelativeHunk(hunks, 25, undefined, -1)).toEqual(hunks[1])
    expect(pickRelativeHunk(hunks, 20, undefined, -1)).toEqual(hunks[0])
  })

  test("with a selection, ignores scrollTop drift", () => {
    const selected = { fileIndex: 0, hunkIndex: 0, scrollTop: 99 }
    expect(pickRelativeHunk(hunks, 15, selected, 1)).toEqual(hunks[1])
  })

  test("jumps across files to the next hunk", () => {
    const selected = { fileIndex: 0, hunkIndex: 1, scrollTop: 20 }
    expect(pickRelativeHunk(hunks, 20, selected, 1)).toEqual(hunks[2])
  })
})
