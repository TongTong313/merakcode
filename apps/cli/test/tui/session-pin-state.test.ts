import { describe, expect, test } from "vitest"
import {
  dedupePinned,
  parsePinnedFromFile,
  removePinnedId,
  togglePinnedIds,
} from "../../src/cli/cmd/tui/component/session-pin-state"

describe("dedupePinned", () => {
  test("removes duplicate ids while preserving first occurrence order", () => {
    expect(dedupePinned(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"])
  })

  test("returns empty array for empty input", () => {
    expect(dedupePinned([])).toEqual([])
  })
})

describe("togglePinnedIds", () => {
  test("appends newly pinned session to the end", () => {
    expect(togglePinnedIds(["session-a", "session-b"], "session-c")).toEqual(["session-a", "session-b", "session-c"])
  })

  test("removes session when toggling an already pinned id", () => {
    expect(togglePinnedIds(["session-a", "session-b", "session-c"], "session-b")).toEqual(["session-a", "session-c"])
  })

  test("dedupes when toggling duplicate state", () => {
    expect(togglePinnedIds(["session-a", "session-a"], "session-b")).toEqual(["session-a", "session-b"])
  })

  test("pinning empty list adds single id", () => {
    expect(togglePinnedIds([], "session-only")).toEqual(["session-only"])
  })

  test("unpinning last pinned session returns empty list", () => {
    expect(togglePinnedIds(["session-only"], "session-only")).toEqual([])
  })
})

describe("parsePinnedFromFile", () => {
  test("reads pinned string array from session.json shape", () => {
    expect(parsePinnedFromFile({ pinned: ["session-a", "session-b"] })).toEqual(["session-a", "session-b"])
  })

  test("filters non-string entries and dedupes", () => {
    expect(parsePinnedFromFile({ pinned: ["session-a", 1, null, "session-a", "session-b"] })).toEqual([
      "session-a",
      "session-b",
    ])
  })

  test("returns empty array for missing or invalid pinned field", () => {
    expect(parsePinnedFromFile(undefined)).toEqual([])
    expect(parsePinnedFromFile(null)).toEqual([])
    expect(parsePinnedFromFile({})).toEqual([])
    expect(parsePinnedFromFile({ pinned: "session-a" })).toEqual([])
    expect(parsePinnedFromFile({ pinned: null })).toEqual([])
  })
})

describe("removePinnedId", () => {
  test("removes deleted session from pinned list", () => {
    expect(removePinnedId(["session-a", "session-b"], "session-a")).toEqual(["session-b"])
  })

  test("returns same array when deleted session was not pinned", () => {
    const pinned = ["session-a"]
    expect(removePinnedId(pinned, "session-missing")).toBe(pinned)
  })
})
