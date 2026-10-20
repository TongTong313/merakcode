import { describe, expect, test } from "vitest"
import { compose, hunks, revert } from "./hunks"

const lines = (count: number, prefix = "line") =>
  Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}\n`).join("")

describe("hunks", () => {
  test("splits distant changes into separate hunks, merges nearby ones, and numbers each line", () => {
    const before = lines(30)
    const after = before.replace("line 3\n", "LINE 3\n").replace("line 5\n", "LINE 5\n").replace("line 25\n", "")
    const result = hunks(before, after)
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ oldStart: 1, newStart: 1 })
    expect(result[0]!.lines.filter((line) => line.kind !== "context").map((line) => [line.kind, line.text])).toEqual([
      ["del", "line 3"],
      ["add", "LINE 3"],
      ["del", "line 5"],
      ["add", "LINE 5"],
    ])
    expect(result[0]!.lines.find((line) => line.text === "line 4")).toMatchObject({ kind: "context", old: 4, new: 4 })
    expect(result[1]!.lines.find((line) => line.kind === "del")).toMatchObject({ text: "line 25", old: 25 })
    expect(new Set(result.map((hunk) => hunk.id)).size).toBe(2)
  })

  test("returns no hunks without changes and one hunk for an added or deleted file", () => {
    expect(hunks("a\nb\n", "a\nb\n")).toEqual([])
    const added = hunks(undefined, "a\nb\n")
    expect(added).toHaveLength(1)
    expect(added[0]!.lines.map((line) => line.kind)).toEqual(["add", "add"])
    const deleted = hunks("a\n", undefined)
    expect(deleted[0]!.lines.map((line) => [line.kind, line.text])).toEqual([["del", "a"]])
  })

  test("gives identical hunks in one file different ids", () => {
    const before = `${lines(10, "a")}x\n${lines(10, "b")}x\n${lines(10, "c")}`
    const after = before.replaceAll("x\n", "y\n")
    const ids = hunks(before, after).map((hunk) => hunk.id)
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
  })

  test("marks a last line without a trailing newline", () => {
    const [hunk] = hunks("a\nb", "a\nc")
    expect(hunk!.lines.at(-1)).toMatchObject({ kind: "add", text: "c", noNewline: true })
  })
})

describe("compose", () => {
  const before = lines(30)
  const after = before.replace("line 2\n", "two\n").replace("line 20\n", "twenty\nextra\n")
  const [first, second] = hunks(before, after)

  test("keeping all hunks gives the new text, none gives the old text, one gives only that change", () => {
    expect(compose(before, after, new Set([first!.id, second!.id]))).toBe(after)
    expect(compose(before, after, new Set())).toBe(before)
    expect(compose(before, after, new Set([second!.id]))).toBe(before.replace("line 20\n", "twenty\nextra\n"))
  })

  test("keeps the remaining hunk id after one hunk is accepted and the base moves forward", () => {
    const baseline = compose(before, after, new Set([first!.id]))
    expect(hunks(baseline, after).map((hunk) => hunk.id)).toEqual([second!.id])
  })

  test("preserves line endings and a missing final newline", () => {
    const crlf = "a\r\nb\r\nc\r\n"
    const changed = "a\r\nB\r\nc\r\n"
    expect(compose(crlf, changed, new Set(hunks(crlf, changed).map((hunk) => hunk.id)))).toBe(changed)
    expect(compose("a\nb", "a\nc", new Set())).toBe("a\nb")
    expect(compose("a\nb", "a\nc", new Set(hunks("a\nb", "a\nc").map((hunk) => hunk.id)))).toBe("a\nc")
  })

  test("ignores CRLF vs LF differences and gives accepted lines the base line ending", () => {
    const crlf = "a\r\nb\r\nc\r\n"
    const lf = "a\nB\nc\n"
    const [hunk] = hunks(crlf, lf)
    expect(hunks(crlf, "a\nb\nc\n")).toEqual([])
    expect(hunk!.lines.filter((line) => line.kind !== "context").map((line) => line.text)).toEqual(["b", "B"])
    expect(compose(crlf, lf, new Set([hunk!.id]))).toBe("a\r\nB\r\nc\r\n")
    // Dropping the final newline is a real change
    expect(hunks("a\nb\n", "a\nb")).toHaveLength(1)
  })

  test("keeps a new file whole when accepted and leaves it absent otherwise", () => {
    const [hunk] = hunks(undefined, "new\n")
    expect(compose(undefined, "new\n", new Set([hunk!.id]))).toBe("new\n")
    expect(compose(undefined, "new\n", new Set())).toBeUndefined()
    const [gone] = hunks("old\n", undefined)
    expect(compose("old\n", undefined, new Set([gone!.id]))).toBeUndefined()
    expect(compose("old\n", undefined, new Set())).toBe("old\n")
  })
})

describe("revert", () => {
  test("reverts only the given hunks and leaves other hunks and unchanged lines as they are", () => {
    const before = lines(30)
    const after = before.replace("line 2\n", "two\n").replace("line 20\n", "twenty\nextra\n")
    const [first, second] = hunks(before, after)
    expect(revert(before, after, new Set([first!.id]))).toBe(before.replace("line 20\n", "twenty\nextra\n"))
    expect(revert(before, after, new Set([first!.id, second!.id]))).toBe(before)
    expect(revert(before, after, new Set())).toBe(after)
  })

  test("keeps the whole file CRLF when reverting a CRLF file against an LF base", () => {
    const before = "a\nb\nc\nd\n"
    const after = "a\r\nB\r\nc\r\nd\r\n"
    expect(revert(before, after, new Set(hunks(before, after).map((hunk) => hunk.id)))).toBe("a\r\nb\r\nc\r\nd\r\n")
  })

  test("reverting removes a new file and restores a deleted one", () => {
    const [added] = hunks(undefined, "new\n")
    expect(revert(undefined, "new\n", new Set([added!.id]))).toBeUndefined()
    const [gone] = hunks("old\n", undefined)
    expect(revert("old\n", undefined, new Set([gone!.id]))).toBe("old\n")
    expect(revert("old\n", undefined, new Set())).toBeUndefined()
  })
})
