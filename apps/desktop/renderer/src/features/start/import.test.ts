import { expect, test } from "vitest"
import { describeImport } from "./import"

const result = {
  from: "v0.3",
  imported: { sessions: 3, messages: 12, groups: 1, agents: 0, roles: 2, plans: 0, memories: 0, todos: 4, blobs: 1 },
  skipped: [
    { kind: "session", id: "ses_bad", code: "MRK-4021", reason: "part prt_bad is not valid JSON" },
    { kind: "todo", id: "ses_x", code: "MRK-4023" },
  ],
  adapters: ["my-script"],
}

test("the import notice becomes counts per kind (only those that are not zero), the skipped items with their codes and the adapters", () => {
  expect(describeImport(JSON.stringify(result), 2)).toEqual({
    counts: [
      { kind: "sessions", count: 3 },
      { kind: "messages", count: 12 },
      { kind: "groups", count: 1 },
      { kind: "roles", count: 2 },
      { kind: "todos", count: 4 },
      { kind: "blobs", count: 1 },
    ],
    skipped: [
      { kind: "session", id: "ses_bad", code: "MRK-4021", reason: "part prt_bad is not valid JSON" },
      { kind: "todo", id: "ses_x", code: "MRK-4023", reason: undefined },
    ],
    hidden: 0,
    adapters: ["my-script"],
  })
})

test("a notice that carries fewer skipped items than its count says how many are not listed", () => {
  expect(describeImport(JSON.stringify(result), 7)?.hidden).toBe(5)
})

test("a run that skipped everything has no counts, and a null skipped list is none", () => {
  const nothing = {
    ...result,
    imported: { ...result.imported, sessions: 0, messages: 0, groups: 0, roles: 0, todos: 0, blobs: 0 },
  }
  expect(describeImport(JSON.stringify(nothing), 2)?.counts).toEqual([])
  expect(describeImport(JSON.stringify({ ...result, skipped: null, adapters: null }), 0)).toMatchObject({
    skipped: [],
    hidden: 0,
    adapters: [],
  })
})

test("text that is not an import result is not described", () => {
  expect(describeImport("MRK-4022", 0)).toBeUndefined()
  expect(describeImport('{"from":"v0.3"}', 0)).toBeUndefined()
})
