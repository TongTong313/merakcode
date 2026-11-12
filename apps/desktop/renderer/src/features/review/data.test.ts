import { expect, test } from "vitest"
import { hunkText, reviewData } from "./data"

test("maps a repository diff to numbered review lines and change counts", () => {
  const result = reviewData([
    {
      path: "note.txt",
      status: "modified",
      staged: false,
      before: "one\ntwo\n",
      after: "one\nthree\n",
      binary: false,
      version: "observed",
    },
  ])
  expect(result.files[0]).toMatchObject({ file: "note.txt", additions: 1, deletions: 1, hunks: 1, version: "observed" })
  expect(result.details["note.txt"]?.hunks[0]?.lines).toEqual([
    { kind: "context", text: "one", old: 1, new: 1 },
    { kind: "del", text: "two", old: 2 },
    { kind: "add", text: "three", new: 2 },
  ])
})

const lines = (...rows: string[]) => rows.map((row) => `${row}\n`).join("")
const change = (before: string, after: string) => ({
  path: "note.txt",
  status: "modified",
  staged: false,
  before,
  after,
  binary: false,
  version: "v",
})
// Two hunks far apart: the first line and the last line change
const before = lines("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l")
const after = lines("A", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "L")
const detail = () => reviewData([change(before, after)]).details["note.txt"]!

test("accepting some hunks gives the contents with only those hunks applied", () => {
  const [first, second] = detail().hunks
  expect(hunkText("accept", detail(), [first!.id])).toBe(
    lines("A", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"),
  )
  expect(hunkText("accept", detail(), [second!.id])).toBe(
    lines("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "L"),
  )
  expect(hunkText("accept", detail(), [first!.id, second!.id])).toBe(after)
})

test("rejecting some hunks gives the contents with those hunks taken back", () => {
  const [first, second] = detail().hunks
  expect(hunkText("reject", detail(), [first!.id])).toBe(
    lines("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "L"),
  )
  expect(hunkText("reject", detail(), [second!.id])).toBe(
    lines("A", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"),
  )
  expect(hunkText("reject", detail(), [first!.id, second!.id])).toBe(before)
})

test("added and removed lines at the ends of a file and a missing final newline survive a hunk decision", () => {
  const grown = reviewData([change("one\ntwo", "zero\none\ntwo\nthree")]).details["note.txt"]!
  expect(grown.hunks).toHaveLength(1)
  expect(hunkText("reject", grown, [grown.hunks[0]!.id])).toBe("one\ntwo")
  expect(hunkText("accept", grown, [grown.hunks[0]!.id])).toBe("zero\none\ntwo\nthree")
  const inserted = reviewData([
    change(
      lines("a", "b", "c", "d", "e", "f", "g", "h", "i", "j"),
      lines("a", "x", "b", "c", "d", "e", "f", "g", "h", "i", "j", "y"),
    ),
  ]).details["note.txt"]!
  const ids = inserted.hunks.map((hunk) => hunk.id)
  expect(ids).toHaveLength(2)
  expect(hunkText("reject", inserted, [ids[0]!])).toBe(lines("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "y"))
  expect(hunkText("accept", inserted, [ids[1]!])).toBe(lines("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "y"))
})
