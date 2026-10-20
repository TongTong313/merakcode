import { describe, expect, test } from "vitest"
import {
  dedupePinned,
  togglePinnedIds,
  parsePinnedFromFile,
  removePinnedId,
} from "../../src/cli/cmd/tui/component/session-pin-state"
import { buildSessionListOptions } from "../../src/cli/cmd/tui/component/session-list-options"

/**
 * End-to-end flow of session pinning, following what a user does:
 * 1. first start (no session.json): the list shows normally
 * 2. pinning a session moves it to the "pinned" section at the top
 * 3. unpinning returns it to the time-sorted list
 * 4. deleting a pinned session removes it from the pinned list
 * 5. after a restart the pinned state is restored
 */

function makeSession(id: string, title: string, updated: number, parentID?: string) {
  return { id, title, parentID, time: { updated } }
}

describe("session pinning: full user flow", () => {
  const today = "2026-07-02"
  const todayLabel = "今天"
  const pinnedLabel = "置顶"

  test("first start without session.json: sessions sorted by time, no pinned section", () => {
    const sessions = [
      makeSession("s1", "最新会话", 500),
      makeSession("s2", "较早会话", 300),
      makeSession("s3", "最旧会话", 100),
    ]

    const pinned = parsePinnedFromFile(undefined)

    const options = buildSessionListOptions({
      sessions,
      pinnedIds: pinned,
      today,
      todayLabel,
      pinnedSectionLabel: pinnedLabel,
    })

    expect(options.filter((o) => o.category === pinnedLabel)).toHaveLength(0)
    // Newest first
    expect(options.map((o) => o.value)).toEqual(["s1", "s2", "s3"])
  })

  test("pinning a session moves it to the pinned section at the top, the rest stay sorted by time", () => {
    const sessions = [makeSession("s1", "最新", 500), makeSession("s2", "中间", 300), makeSession("s3", "最旧", 100)]

    let pinned = togglePinnedIds([], "s3")

    const options = buildSessionListOptions({
      sessions,
      pinnedIds: pinned,
      today,
      todayLabel,
      pinnedSectionLabel: pinnedLabel,
    })

    expect(options.map((o) => o.value)).toEqual(["s3", "s1", "s2"])
    expect(options[0].category).toBe(pinnedLabel)
    expect(options[1].category).not.toBe(pinnedLabel)
  })

  test("pinned sessions are listed at the top in pin order", () => {
    const sessions = [
      makeSession("s1", "会话1", 500),
      makeSession("s2", "会话2", 400),
      makeSession("s3", "会话3", 300),
      makeSession("s4", "会话4", 200),
    ]

    let pinned: string[] = []
    pinned = togglePinnedIds(pinned, "s3")
    pinned = togglePinnedIds(pinned, "s1")

    const options = buildSessionListOptions({
      sessions,
      pinnedIds: pinned,
      today,
      todayLabel,
      pinnedSectionLabel: pinnedLabel,
    })

    expect(options.map((o) => o.value)).toEqual(["s3", "s1", "s2", "s4"])
    expect(options[0].category).toBe(pinnedLabel)
    expect(options[1].category).toBe(pinnedLabel)
    expect(options[2].category).not.toBe(pinnedLabel)
  })

  test("unpinning returns a session to its time-sorted position", () => {
    const sessions = [makeSession("s1", "最新", 500), makeSession("s2", "中间", 300), makeSession("s3", "最旧", 100)]

    let pinned = togglePinnedIds([], "s3")

    let options = buildSessionListOptions({
      sessions,
      pinnedIds: pinned,
      today,
      todayLabel,
      pinnedSectionLabel: pinnedLabel,
    })
    expect(options.map((o) => o.value)).toEqual(["s3", "s1", "s2"])

    pinned = togglePinnedIds(pinned, "s3")

    options = buildSessionListOptions({
      sessions,
      pinnedIds: pinned,
      today,
      todayLabel,
      pinnedSectionLabel: pinnedLabel,
    })

    expect(options.map((o) => o.value)).toEqual(["s1", "s2", "s3"])
    expect(options.filter((o) => o.category === pinnedLabel)).toHaveLength(0)
  })

  test("deleting a pinned session removes it from the pinned list", () => {
    let pinned = ["s1", "s2", "s3"]

    pinned = removePinnedId(pinned, "s2")

    expect(pinned).toEqual(["s1", "s3"])
  })

  test("deleting an unpinned session leaves the pinned list unchanged", () => {
    const pinned = ["s1", "s3"]

    const result = removePinnedId(pinned, "s99")

    expect(result).toEqual(["s1", "s3"])
    expect(result).toBe(pinned)
  })

  test("pinned IDs survive a write and read of session.json", () => {
    let pinned: string[] = []
    pinned = togglePinnedIds(pinned, "s2")
    pinned = togglePinnedIds(pinned, "s3")

    const fileContent = { pinned }
    const json = JSON.stringify(fileContent)

    const parsed = JSON.parse(json)
    const restored = parsePinnedFromFile(parsed)

    expect(restored).toEqual(["s2", "s3"])
  })

  test("a corrupt pinned file silently falls back to an empty list", () => {
    expect(parsePinnedFromFile(undefined)).toEqual([])
    expect(parsePinnedFromFile(null)).toEqual([])
    expect(parsePinnedFromFile("bad")).toEqual([])
    expect(parsePinnedFromFile(42)).toEqual([])
    expect(parsePinnedFromFile({ pinned: "not-array" })).toEqual([])
    expect(parsePinnedFromFile({ pinned: null })).toEqual([])
    expect(parsePinnedFromFile({ pinned: [1, 2, 3] })).toEqual([]) // not strings
  })

  test("child sessions cannot be pinned, only root sessions", () => {
    const sessions = [makeSession("parent", "父会话", 500), makeSession("child", "子会话", 400, "parent")]

    const pinned = togglePinnedIds([], "child")

    const options = buildSessionListOptions({
      sessions,
      pinnedIds: pinned,
      today,
      todayLabel,
      pinnedSectionLabel: pinnedLabel,
    })

    // Child sessions are not in the root list, so the pinned section stays empty
    expect(options.filter((o) => o.category === pinnedLabel)).toHaveLength(0)
    expect(options.map((o) => o.value)).toEqual(["parent"])
  })

  test("with every session pinned, only the pinned section shows", () => {
    const sessions = [makeSession("s1", "会话1", 300), makeSession("s2", "会话2", 200), makeSession("s3", "会话3", 100)]

    const pinned = ["s1", "s2", "s3"]

    const options = buildSessionListOptions({
      sessions,
      pinnedIds: pinned,
      today,
      todayLabel,
      pinnedSectionLabel: pinnedLabel,
    })

    expect(options.map((o) => o.value)).toEqual(["s1", "s2", "s3"])
    for (const opt of options) {
      expect(opt.category).toBe(pinnedLabel)
    }
  })

  test("pinned IDs are deduplicated, guarding against bad persisted data", () => {
    const sessions = [makeSession("s1", "会话1", 300), makeSession("s2", "会话2", 200)]

    // Duplicates can come from an old bug or manual edits
    const options = buildSessionListOptions({
      sessions,
      pinnedIds: ["s1", "s1", "s2", "s1"],
      today,
      todayLabel,
      pinnedSectionLabel: pinnedLabel,
    })

    expect(options.map((o) => o.value)).toEqual(["s1", "s2"])
    expect(options.filter((o) => o.category === pinnedLabel)).toHaveLength(2)
  })

  test("toggling a pin rapidly leaves a consistent state", () => {
    let pinned: string[] = []

    pinned = togglePinnedIds(pinned, "s1")
    pinned = togglePinnedIds(pinned, "s1")
    pinned = togglePinnedIds(pinned, "s1")
    pinned = togglePinnedIds(pinned, "s1")
    pinned = togglePinnedIds(pinned, "s1")

    expect(pinned).toEqual(["s1"])
    expect(dedupePinned(pinned)).toEqual(["s1"])
  })

  test("pins of several sessions change independently", () => {
    let pinned: string[] = []

    pinned = togglePinnedIds(pinned, "s3")
    pinned = togglePinnedIds(pinned, "s1")
    pinned = togglePinnedIds(pinned, "s2")

    expect(pinned).toEqual(["s3", "s1", "s2"])

    pinned = togglePinnedIds(pinned, "s1")
    expect(pinned).toEqual(["s3", "s2"])

    pinned = togglePinnedIds(pinned, "s1")
    expect(pinned).toEqual(["s3", "s2", "s1"])
  })

  test("pinned IDs with an empty session list show nothing", () => {
    const options = buildSessionListOptions({
      sessions: [],
      pinnedIds: ["ghost-session"],
      today,
      todayLabel,
      pinnedSectionLabel: pinnedLabel,
    })

    expect(options).toHaveLength(0)
  })

  test("a pinned session stays in the pinned section after it is updated", () => {
    const sessions = [
      makeSession("s1", "被更新的置顶会话", 999),
      makeSession("s2", "普通新会话", 500),
      makeSession("s3", "普通旧会话", 100),
    ]

    const pinned = ["s1"]

    const options = buildSessionListOptions({
      sessions,
      pinnedIds: pinned,
      today,
      todayLabel,
      pinnedSectionLabel: pinnedLabel,
    })

    expect(options.map((o) => o.value)).toEqual(["s1", "s2", "s3"])
    expect(options[0].category).toBe(pinnedLabel)
    expect(options[0].updated).toBe(999)
  })
})

describe("session pinning: other DialogSelect dialogs are unaffected", () => {
  test("pinning does not mutate the original session data", () => {
    const sessions = [makeSession("s1", "会话1", 500), makeSession("s2", "会话2", 300), makeSession("s3", "会话3", 100)]

    const original = structuredClone(sessions)
    const pinned = ["s2"]

    buildSessionListOptions({
      sessions,
      pinnedIds: pinned,
      today: "2026-07-02",
      todayLabel: "今天",
      pinnedSectionLabel: "置顶",
    })

    expect(sessions).toEqual(original)
  })

  test("buildSessionListOptions returns one option per root session", () => {
    const sessions = [
      makeSession("s1", "根1", 500),
      makeSession("s2", "子会话", 400, "s1"),
      makeSession("s3", "根2", 300),
      makeSession("s4", "子会话2", 200, "s3"),
    ]

    const options = buildSessionListOptions({
      sessions,
      pinnedIds: ["s3"],
      today: "2026-07-02",
      todayLabel: "今天",
      pinnedSectionLabel: "置顶",
    })

    // Only the two root sessions; child sessions are filtered out
    expect(options).toHaveLength(2)
    expect(options.map((o) => o.value).sort()).toEqual(["s1", "s3"].sort())
  })

  test("pinning does not depend on session titles or time values", () => {
    const sessions = [
      makeSession("s1", "", 0),
      makeSession("s2", "!@#$%", -1),
      makeSession("s3", "中文标题🎉", Number.MAX_SAFE_INTEGER),
    ]

    const options = buildSessionListOptions({
      sessions,
      pinnedIds: ["s2"],
      today: new Date(0).toDateString(),
      todayLabel: "今天",
      pinnedSectionLabel: "置顶",
    })

    expect(options).toHaveLength(3)
    expect(options[0].value).toBe("s2")
    expect(options[0].category).toBe("置顶")
  })
})

describe("session pinning: with the session.deleted event", () => {
  test("removePinnedId removes a deleted session", () => {
    // On session.deleted, sync.tsx removes the session from store.session and local.tsx calls removePinnedId
    const pinnedBefore = ["s1", "s2", "s3", "s4"]
    const deletedID = "s2"

    const pinnedAfter = removePinnedId(pinnedBefore, deletedID)

    expect(pinnedAfter).toEqual(["s1", "s3", "s4"])
  })

  test("deleting an unknown session leaves the pinned list unchanged", () => {
    const pinned = ["s1", "s2"]

    const result = removePinnedId(pinned, "nonexistent")

    expect(result).toEqual(["s1", "s2"])
    expect(result).toBe(pinned)
  })

  test("deleting the only pinned session leaves an empty list", () => {
    const pinned = ["only-session"]

    const result = removePinnedId(pinned, "only-session")

    expect(result).toEqual([])
  })
})
