import { describe, expect, test } from "vitest"
import {
  buildFileTree,
  flattenFileTree,
  moveFileTreeSelection,
  fileTreeFileSelection,
  toggleFileTreeDirectory,
  allExpandedFileTreeDirectories,
  movePatchFileIndex,
  orderedPatchFileIndexes,
  showDiffViewerFileTree,
  singlePatchFileIndex,
  stableIndexList,
  type FileTreeItem,
} from "../../src/cli/cmd/tui/routes/diff/file-tree-utils"

function f(name: string, status?: "added" | "deleted" | "modified"): FileTreeItem {
  return { file: name, status: status ?? "modified" }
}

describe("buildFileTree", () => {
  test("a file in a subdirectory creates a directory → file structure", () => {
    const t = buildFileTree([f("src/index.ts")])
    const dir = t.nodes[t.roots[0]!]!
    expect(dir.kind).toBe("directory")
    expect(dir.name).toBe("src")
    const child = t.nodes[dir.children[0]!]!
    expect(child.kind).toBe("file")
    expect(child.name).toBe("index.ts")
  })

  test("a file at the root becomes a root node", () => {
    const t = buildFileTree([f("app.ts")])
    const node = t.nodes[t.roots[0]!]!
    expect(node.kind).toBe("file")
    expect(node.name).toBe("app.ts")
  })

  test("two files sharing a directory create it only once", () => {
    const t = buildFileTree([f("src/a.ts"), f("src/b.ts")])
    expect(t.roots).toHaveLength(1)
    expect(t.nodes[t.roots[0]!]!.children).toHaveLength(2)
  })

  test("three levels of nesting: a/b/c.ts", () => {
    const t = buildFileTree([f("a/b/c.ts")])
    const a = t.nodes[t.roots[0]!]!
    expect(a.name).toBe("a")
    const b = t.nodes[a.children[0]!]!
    expect(b.name).toBe("b")
    const c = t.nodes[b.children[0]!]!
    expect(c.name).toBe("c.ts")
    expect(c.kind).toBe("file")
  })

  test("empty input gives an empty tree", () => {
    const t = buildFileTree([])
    expect(t.roots).toHaveLength(0)
  })

  test("an empty file name is ignored", () => {
    const t = buildFileTree([f("")])
    expect(t.roots).toHaveLength(0)
  })

  test("directories always come before files", () => {
    const t = buildFileTree([f("src/root.ts"), f("src/sub/nested.ts")])
    const children = t.nodes[t.roots[0]!]!.children.map((id) => t.nodes[id]!)
    expect(children[0]!.kind).toBe("directory")
    expect(children[1]!.kind).toBe("file")
  })

  test("siblings are sorted alphabetically", () => {
    const t = buildFileTree([f("z.ts"), f("a.ts"), f("m.ts")])
    const names = t.roots.map((id) => t.nodes[id]!.name)
    expect(names).toEqual(["a.ts", "m.ts", "z.ts"])
  })

  test("files with the same name in different directories do not collide", () => {
    const t = buildFileTree([f("a/index.ts"), f("b/index.ts")])
    expect(t.roots).toHaveLength(2)
  })
})

describe("flattenFileTree", () => {
  test("a chain of single-child directories collapses into one row", () => {
    const t = buildFileTree([f("src/sub/deep.ts")])
    const rows = flattenFileTree(t)
    expect(rows).toHaveLength(2)
    expect(rows[0]!.kind).toBe("directory")
    expect(rows[1]!.kind).toBe("file")
  })

  test("a file at the root shows as is, without collapsing", () => {
    const t = buildFileTree([f("root.ts")])
    const rows = flattenFileTree(t)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe("file")
  })

  test("an expanded directory shows its children", () => {
    const t = buildFileTree([f("src/a.ts"), f("src/b.ts")])
    const rootId = t.roots[0]!
    const rows = flattenFileTree(t, new Set([rootId]))
    expect(rows).toHaveLength(3)
    expect(rows[0]!.name).toBe("src")
    expect(rows[1]!.name).toBe("a.ts")
    expect(rows[2]!.name).toBe("b.ts")
  })

  test("an empty tree gives an empty array", () => {
    expect(flattenFileTree(buildFileTree([]))).toEqual([])
  })
})

describe("moveFileTreeSelection", () => {
  function rows() {
    const t = buildFileTree([f("src/a.ts"), f("src/b.ts"), f("c.ts")])
    return flattenFileTree(t, new Set([t.roots[0]!]))
  }

  test("↓ moves down one row", () => {
    const r = rows()
    expect(moveFileTreeSelection(r, r[0]!.id, 1)).toBe(r[1]!.id)
  })

  test("↑ moves up one row", () => {
    const r = rows()
    expect(moveFileTreeSelection(r, r[1]!.id, -1)).toBe(r[0]!.id)
  })

  test("↑ at the top stays on the first row", () => {
    const r = rows()
    expect(moveFileTreeSelection(r, r[0]!.id, -1)).toBe(r[0]!.id)
  })

  test("↓ at the bottom stays on the last row", () => {
    const r = rows()
    const last = r[r.length - 1]!.id
    expect(moveFileTreeSelection(r, last, 1)).toBe(last)
  })

  test("an empty list has no selection", () => {
    expect(moveFileTreeSelection([], undefined, 1)).toBeUndefined()
  })

  test("without a selection, picks the first row", () => {
    const r = rows()
    expect(moveFileTreeSelection(r, undefined, 1)).toBe(r[0]!.id)
  })
})

describe("fileTreeFileSelection", () => {
  test("a found file returns its node and the IDs of all its parent directories", () => {
    const t = buildFileTree([f("src/sub/a.ts")])
    const result = fileTreeFileSelection(t, 0)
    expect(result).toBeDefined()
    expect(result!.expandedNodes.size).toBe(2)
  })

  test("returns undefined for an unknown fileIndex", () => {
    const t = buildFileTree([f("a.ts")])
    expect(fileTreeFileSelection(t, 99)).toBeUndefined()
  })
})

describe("toggleFileTreeDirectory", () => {
  test("collapsed → expanded", () => {
    const t = buildFileTree([f("src/a.ts")])
    const dirId = t.roots[0]!
    expect(toggleFileTreeDirectory(t, new Set(), dirId).has(dirId)).toBe(true)
  })

  test("expanded → collapsed", () => {
    const t = buildFileTree([f("src/a.ts")])
    const dirId = t.roots[0]!
    expect(toggleFileTreeDirectory(t, new Set([dirId]), dirId).has(dirId)).toBe(false)
  })

  test("has no effect on a file node", () => {
    const t = buildFileTree([f("a.ts")])
    const fileId = t.roots[0]!
    expect(toggleFileTreeDirectory(t, new Set(), fileId).size).toBe(0)
  })

  test("an undefined selection returns the original set unchanged", () => {
    const t = buildFileTree([f("a.ts")])
    const original = new Set([1])
    expect(toggleFileTreeDirectory(t, original, undefined)).toBe(original)
  })
})

describe("allExpandedFileTreeDirectories", () => {
  test("returns every nested directory", () => {
    const t = buildFileTree([f("src/sub/a.ts"), f("src/b.ts")])
    expect(allExpandedFileTreeDirectories(t).size).toBe(2)
  })

  test("returns an empty set when there are no directories", () => {
    const t = buildFileTree([f("a.ts"), f("b.ts")])
    expect(allExpandedFileTreeDirectories(t).size).toBe(0)
  })
})

describe("movePatchFileIndex", () => {
  test("moves back and forth through the file index list", () => {
    const indexes = [0, 2, 5]
    expect(movePatchFileIndex(indexes, 2, 1)).toBe(5)
    expect(movePatchFileIndex(indexes, 2, -1)).toBe(0)
  })

  test("without a selection, picks the first entry", () => {
    expect(movePatchFileIndex([1, 3], undefined, 1)).toBe(1)
  })

  test("stops at the edges", () => {
    expect(movePatchFileIndex([1, 3], 3, 1)).toBe(3)
    expect(movePatchFileIndex([1, 3], 1, -1)).toBe(1)
  })

  test("returns undefined for an empty list", () => {
    expect(movePatchFileIndex([], 0, 1)).toBeUndefined()
  })
})

describe("orderedPatchFileIndexes", () => {
  test("collects fileIndex values in flattened row order", () => {
    const t = buildFileTree([f("src/a.ts"), f("src/b.ts"), f("c.ts")])
    const rows = flattenFileTree(t, allExpandedFileTreeDirectories(t))
    expect(orderedPatchFileIndexes(rows)).toEqual([0, 1, 2])
  })

  test("skips directory rows", () => {
    const t = buildFileTree([f("src/a.ts")])
    const rows = flattenFileTree(t)
    expect(orderedPatchFileIndexes(rows)).toEqual([0])
  })
})

describe("showDiffViewerFileTree", () => {
  test("requires both the toggle on and at least one file", () => {
    expect(showDiffViewerFileTree(true, 3)).toBe(true)
    expect(showDiffViewerFileTree(false, 3)).toBe(false)
    expect(showDiffViewerFileTree(true, 0)).toBe(false)
  })
})

describe("singlePatchFileIndex", () => {
  test("takes the first valid index in priority order", () => {
    expect(singlePatchFileIndex(2, 1, 0, 5)).toBe(2)
    expect(singlePatchFileIndex(undefined, 1, undefined, 5)).toBe(1)
    expect(singlePatchFileIndex(undefined, undefined, undefined, 5)).toBe(5)
  })
})

describe("stableIndexList", () => {
  test("reuses the previous array when the contents are equal", () => {
    const prev = [0, 2, 5]
    const next = [0, 2, 5]
    expect(stableIndexList(prev, next)).toBe(prev)
  })

  test("returns the new array when the contents change", () => {
    const prev = [0, 2, 5]
    const next = [0, 2, 6]
    expect(stableIndexList(prev, next)).toBe(next)
  })
})
