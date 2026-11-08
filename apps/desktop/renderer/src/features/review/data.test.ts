import { expect, test } from "vitest"
import { reviewData } from "./data"

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
