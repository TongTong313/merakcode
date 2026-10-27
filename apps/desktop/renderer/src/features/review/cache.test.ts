import type { ReviewFile, ReviewFileDetail } from "@merakcode/sdk/client"
import { describe, expect, test } from "vitest"
import { autoExpand, budget, detailKey, detailSize, keyOf, PREFETCH, prefetchQueue } from "./cache"

const file = (name: string, lines = 2, extra: Partial<ReviewFile> = {}): ReviewFile => ({
  file: name,
  status: "modified",
  additions: lines / 2,
  deletions: lines / 2,
  hunks: 1,
  version: `v-${name}`,
  ...extra,
})

describe("review cache keys", () => {
  test("each conversation, turn and checkout is its own list", () => {
    const base = { directory: "/repo", scope: "session" as const }
    expect(keyOf({ ...base, checkout: "one" })).not.toBe(keyOf({ ...base, checkout: "two" }))
    expect(keyOf({ directory: "/repo", scope: "turn", sessionID: "s", messageID: "m1" })).not.toBe(
      keyOf({ directory: "/repo", scope: "turn", sessionID: "s", messageID: "m2" }),
    )
  })

  test("details stay valid until the content version changes", () => {
    const list = keyOf({ directory: "/repo", scope: "session" })
    const a = file("a.ts")
    expect(detailKey(list, { ...a })).toBe(detailKey(list, a))
    expect(detailKey(list, { ...a, version: "v2" })).not.toBe(detailKey(list, a))
  })
})

describe("which files open on their own", () => {
  test("a few small files open; many files or many lines start collapsed", () => {
    expect(autoExpand([file("a"), file("b")])).toBe(true)
    expect(autoExpand(Array.from({ length: 6 }, (_, i) => file(`f${i}`)))).toBe(false)
    expect(autoExpand([file("a", 400)])).toBe(false)
  })
})

describe("prefetch", () => {
  test("skips files already loaded, binary or truncated files and huge diffs, and stops at the file limit", () => {
    const files = [
      file("cached"),
      file("bin", 2, { binary: true }),
      file("huge", PREFETCH.fileLines + 2),
      ...Array.from({ length: PREFETCH.files + 5 }, (_, i) => file(`f${i}`)),
    ]
    const queue = prefetchQueue(files, (item) => item.file === "cached")
    expect(queue).toHaveLength(PREFETCH.files)
    expect(queue[0]!.file).toBe("f0")
    expect(queue.some((item) => ["cached", "bin", "huge"].includes(item.file))).toBe(false)
  })

  test("a detail counts its full text and its lines", () => {
    const detail: ReviewFileDetail = {
      file: "a",
      version: "v",
      before: "abc",
      after: "abcd",
      hunks: [{ id: "h", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [{ kind: "add", text: "xy" }] }],
    }
    expect(detailSize(detail)).toBe(3 + 4 + 3)
  })
})

describe("render budget", () => {
  test("fills hunks in order and leaves later hunks empty", () => {
    const hunk = (count: number) => ({ lines: Array.from({ length: count }) })
    expect(budget([hunk(100), hunk(250), hunk(50)], 300)).toEqual([100, 200, 0])
    expect(budget([hunk(10)], 300)).toEqual([10])
  })
})
