import { describe, expect, test } from "vitest"
import { buildSessionListOptions } from "../../src/cli/cmd/tui/component/session-list-options"

function session(id: string, title: string, updated: number, parentID?: string) {
  return {
    id,
    title,
    parentID,
    time: {
      updated,
    },
  }
}

describe("buildSessionListOptions", () => {
  test("places pinned root sessions before recent sessions while preserving pinned order", () => {
    const options = buildSessionListOptions({
      sessions: [
        session("session-old", "Old session", 100),
        session("session-new", "New session", 300),
        session("session-mid", "Middle session", 200),
      ],
      pinnedIds: ["session-mid", "session-old"],
      today: new Date(300).toDateString(),
      todayLabel: "Today",
      pinnedSectionLabel: "Pinned",
    })

    expect(options.map((x) => x.value)).toEqual(["session-mid", "session-old", "session-new"])
    expect(options.map((x) => x.category)).toEqual(["Pinned", "Pinned", "Today"])
  })

  test("dedupes pinned ids and ignores stale or child session ids", () => {
    const options = buildSessionListOptions({
      sessions: [
        session("session-parent", "Parent", 300),
        session("session-child", "Child", 400, "session-parent"),
        session("session-other", "Other", 200),
      ],
      pinnedIds: ["missing", "session-child", "session-parent", "session-parent"],
      today: new Date(300).toDateString(),
      todayLabel: "Today",
      pinnedSectionLabel: "Pinned",
    })

    expect(options.map((x) => x.value)).toEqual(["session-parent", "session-other"])
    expect(options.filter((x) => x.category === "Pinned")).toHaveLength(1)
  })

  test("appends newly pinned session to the bottom of the pinned section", () => {
    const options = buildSessionListOptions({
      sessions: [
        session("session-first", "First pinned", 500),
        session("session-second", "Second pinned", 400),
        session("session-new", "Newly pinned", 300),
        session("session-other", "Other", 200),
      ],
      pinnedIds: ["session-first", "session-second", "session-new"],
      today: "not-today",
      todayLabel: "Today",
      pinnedSectionLabel: "Pinned",
    })

    expect(options.map((x) => x.value)).toEqual(["session-first", "session-second", "session-new", "session-other"])
    expect(options.filter((x) => x.category === "Pinned")).toHaveLength(3)
  })

  test("sorts unpinned root sessions by updated time descending", () => {
    const options = buildSessionListOptions({
      sessions: [
        session("session-old", "Old session", 100),
        session("session-new", "New session", 300),
        session("session-mid", "Middle session", 200),
      ],
      pinnedIds: [],
      today: "not-today",
      todayLabel: "Today",
      pinnedSectionLabel: "Pinned",
    })

    expect(options.map((x) => x.value)).toEqual(["session-new", "session-mid", "session-old"])
  })

  test("returns empty list when there are no root sessions", () => {
    expect(
      buildSessionListOptions({
        sessions: [session("session-child", "Child", 300, "session-parent")],
        pinnedIds: ["session-child", "session-parent"],
        today: "not-today",
        todayLabel: "Today",
        pinnedSectionLabel: "Pinned",
      }),
    ).toEqual([])
  })

  test("shows only pinned section when every root session is pinned", () => {
    const options = buildSessionListOptions({
      sessions: [session("session-a", "A", 300), session("session-b", "B", 200)],
      pinnedIds: ["session-b", "session-a"],
      today: "not-today",
      todayLabel: "Today",
      pinnedSectionLabel: "Pinned",
    })

    expect(options.map((x) => x.value)).toEqual(["session-b", "session-a"])
    expect(options.every((x) => x.category === "Pinned")).toBe(true)
  })

  test("places unpinned session back into today section after unpin", () => {
    const today = new Date("2026-06-30T12:00:00").toDateString()
    const options = buildSessionListOptions({
      sessions: [
        session("session-pinned", "Pinned", Date.parse("2026-06-30T10:00:00")),
        session("session-today", "Today session", Date.parse("2026-06-30T11:00:00")),
        session("session-old", "Old session", Date.parse("2026-06-01T12:00:00")),
      ],
      pinnedIds: ["session-pinned"],
      today,
      todayLabel: "Today",
      pinnedSectionLabel: "Pinned",
    })

    expect(options.map((x) => x.value)).toEqual(["session-pinned", "session-today", "session-old"])
    expect(options.map((x) => x.category)).toEqual(["Pinned", "Today", new Date("2026-06-01T12:00:00").toDateString()])
  })

  test("ignores pinned ids that are not present in current session source", () => {
    const options = buildSessionListOptions({
      sessions: [session("session-a", "A", 300)],
      pinnedIds: ["missing-a", "session-a", "missing-b"],
      today: "not-today",
      todayLabel: "Today",
      pinnedSectionLabel: "Pinned",
    })

    expect(options.map((x) => x.value)).toEqual(["session-a"])
  })
})
