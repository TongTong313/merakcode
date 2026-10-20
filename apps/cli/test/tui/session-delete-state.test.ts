import { describe, expect, test } from "vitest"
import {
  moveSessionDelete,
  nextSessionAfterDelete,
  removeSessionTree,
  retainSessionDelete,
  sessionRouteAfterDelete,
  triggerSessionDelete,
} from "../../src/cli/cmd/tui/component/session-delete-state"

describe("session delete confirmation", () => {
  test("keeps confirmation when hover remains on the same session", () => {
    expect(moveSessionDelete("session-a", "session-a")).toBe("session-a")
  })

  test("clears confirmation when selection moves to another session", () => {
    expect(moveSessionDelete("session-a", "session-b")).toBeUndefined()
  })

  test("requires two triggers on the same session", () => {
    const pending = triggerSessionDelete(undefined, "session-a")
    expect(pending).toEqual({ type: "pending", sessionID: "session-a" })

    const sameHover = moveSessionDelete(pending.sessionID, "session-a")
    expect(triggerSessionDelete(sameHover, "session-a")).toEqual({ type: "delete", sessionID: "session-a" })
  })

  test("moving to another session requires a new confirmation", () => {
    const moved = moveSessionDelete("session-a", "session-b")
    expect(triggerSessionDelete(moved, "session-b")).toEqual({ type: "pending", sessionID: "session-b" })
  })

  test("clears confirmation when async results remove the pending session", () => {
    expect(retainSessionDelete("session-a", ["session-b"])).toBeUndefined()
    expect(retainSessionDelete("session-a", ["session-a", "session-b"])).toBe("session-a")
  })
})

describe("session route after delete", () => {
  test("uses the next visible session", () => {
    expect(nextSessionAfterDelete(["session-a", "session-b", "session-c"], "session-b")).toBe("session-c")
  })

  test("falls back to the previous visible session", () => {
    expect(nextSessionAfterDelete(["session-a", "session-b"], "session-b")).toBe("session-a")
  })

  test("returns no target when the list becomes empty", () => {
    expect(nextSessionAfterDelete(["session-a"], "session-a")).toBeUndefined()
  })

  test("does not select a target for an unknown session", () => {
    expect(nextSessionAfterDelete(["session-a", "session-b"], "session-c")).toBeUndefined()
  })

  test("navigates the current session to its next visible neighbor", () => {
    expect(sessionRouteAfterDelete("session-b", "session-b", ["session-a", "session-b", "session-c"])).toEqual({
      type: "session",
      sessionID: "session-c",
    })
  })

  test("navigates home when the current session has no visible neighbor", () => {
    expect(sessionRouteAfterDelete("session-a", "session-a", ["session-a"])).toEqual({ type: "home" })
  })

  test("does not navigate when deleting a non-current session", () => {
    expect(sessionRouteAfterDelete("session-a", "session-b", ["session-a", "session-b"])).toBeUndefined()
  })
})

describe("session tree removal", () => {
  test("removes a root session and all descendants", () => {
    const sessions = [
      { id: "session-a" },
      { id: "session-child", parentID: "session-a" },
      { id: "session-grandchild", parentID: "session-child" },
      { id: "session-b" },
    ]

    expect(removeSessionTree(sessions, "session-a")).toEqual([{ id: "session-b" }])
  })

  test("does not mutate the source list", () => {
    const sessions = [{ id: "session-a" }, { id: "session-b" }]
    removeSessionTree(sessions, "session-a")
    expect(sessions).toHaveLength(2)
  })
})
