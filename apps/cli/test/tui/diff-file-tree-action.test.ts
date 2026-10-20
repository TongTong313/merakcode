import { describe, expect, test } from "vitest"
import { resolveFileTreeActivation } from "../../src/cli/cmd/tui/routes/diff/diff-file-tree-action"
import type { FileTreeRow } from "../../src/cli/cmd/tui/routes/diff/file-tree-utils"

describe("resolveFileTreeActivation", () => {
  test("no row is a noop", () => {
    expect(resolveFileTreeActivation(undefined, undefined)).toEqual({ type: "noop" })
  })

  test("a file row scrolls to its fileIndex", () => {
    const row: FileTreeRow = { id: 2, depth: 1, kind: "file", name: "a.ts", fileIndex: 0 }
    expect(resolveFileTreeActivation(row, undefined)).toEqual({ type: "scroll-to-file", fileIndex: 0 })
  })

  test("activating the already selected file does not scroll (avoids flicker)", () => {
    const row: FileTreeRow = { id: 2, depth: 1, kind: "file", name: "a.ts", fileIndex: 0 }
    expect(resolveFileTreeActivation(row, 0)).toEqual({ type: "noop" })
  })

  test("a directory row toggles its expanded state", () => {
    const row: FileTreeRow = { id: 1, depth: 0, kind: "directory", name: "src" }
    expect(resolveFileTreeActivation(row, undefined)).toEqual({ type: "toggle-directory", nodeId: 1 })
  })
})
