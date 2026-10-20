import { expect, test } from "vitest"
import { createSessionRequests } from "../../src/cli/cmd/tui/context/session-requests"

for (const outcome of ["success", "failure", "cancelled"] as const) {
  test(`command is immediately busy and settles on ${outcome} without a server event`, async () => {
    const states = new Map<string, string>()
    const requests = createSessionRequests(
      (sessionID) => states.set(sessionID, "idle"),
      (sessionID) => states.set(sessionID, "busy"),
    )
    const response = Promise.withResolvers<void>()
    requests.claim("session", "command-message")
    expect(states.get("session")).toBe("busy")
    const sent = response.promise.catch(() => {}).finally(() => requests.settle("session", "command-message", true))
    if (outcome === "success") response.resolve()
    else response.reject(new Error(outcome))
    await sent
    expect(states.get("session")).toBe("idle")
    expect(requests.settle("session", "command-message", true)).toBe(false)
  })
}

test("late command completion cannot remove the immediate busy state of a new command", () => {
  let status = "idle"
  const requests = createSessionRequests(
    () => {
      status = "idle"
    },
    () => {
      status = "busy"
    },
  )
  requests.claim("session", "old-command")
  requests.claim("session", "new-command")
  expect(requests.settle("session", "old-command", true)).toBe(false)
  expect(status).toBe("busy")
  expect(requests.settle("session", "new-command", true)).toBe(true)
  expect(status).toBe("idle")
})

test("an old command rejection cannot clear a new prompt after the consumer is replaced", async () => {
  const idle: string[] = []
  const requests = createSessionRequests((sessionID) => idle.push(sessionID))
  const rejected = Promise.withResolvers<void>()
  requests.claim("session", "command-message")
  const old = rejected.promise
    .catch(() => requests.settle("session", "command-message", true))
    .finally(() => requests.settle("session", "command-message"))
  // The SyncProvider's tracker is shared by both the disposed and remounted Prompt.
  requests.claim("session", "new-prompt-message")
  rejected.reject(new Error("finite old command failure"))
  await old
  expect(idle).toEqual([])
  expect(requests.settle("session", "new-prompt-message", true)).toBe(true)
  expect(idle).toEqual(["session"])
})

test("late successful completion also preserves newer ownership and current failure settles only once", () => {
  const idle: string[] = []
  const requests = createSessionRequests((sessionID) => idle.push(sessionID))
  requests.claim("session", "old-prompt")
  requests.claim("session", "new-prompt")
  expect(requests.settle("session", "old-prompt")).toBe(false)
  expect(requests.settle("session", "new-prompt", true)).toBe(true)
  expect(requests.settle("session", "new-prompt", true)).toBe(false)
  expect(idle).toEqual(["session"])
})

test("different sessions retain independent ownership and success relies on server status", () => {
  const idle: string[] = []
  const requests = createSessionRequests((sessionID) => idle.push(sessionID))
  requests.claim("one", "first")
  requests.claim("two", "second")
  expect(requests.settle("one", "first")).toBe(true)
  expect(idle).toEqual([])
  expect(requests.settle("two", "second", true)).toBe(true)
  expect(idle).toEqual(["two"])
})
