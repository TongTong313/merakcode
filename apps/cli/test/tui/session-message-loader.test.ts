import { describe, expect, test } from "vitest"
import {
  createSessionMessageLoader,
  limitSessionSnapshot,
  mergeSessionSnapshot,
  type SessionMessageLoadState,
} from "../../src/cli/cmd/tui/context/session-message-loader"

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

function setup(load: (sessionID: string, context: { isCurrent(): boolean }) => Promise<void>) {
  const states = new Map<string, SessionMessageLoadState>()
  const loader = createSessionMessageLoader({
    get: (sessionID) => states.get(sessionID) ?? { status: "idle" },
    set: (sessionID, state) => states.set(sessionID, state),
    load,
  })
  return { loader, states }
}

describe("createSessionMessageLoader", () => {
  test("coalesces concurrent loads for the same session and caches success", async () => {
    const request = deferred()
    const calls: string[] = []
    const { loader, states } = setup((sessionID) => {
      calls.push(sessionID)
      return request.promise
    })

    const first = loader.ensure("child")
    const second = loader.ensure("child")

    expect(first).toBe(second)
    expect(states.get("child")).toEqual({ status: "loading" })
    await Promise.resolve()
    expect(calls).toEqual(["child"])

    request.resolve()
    await first
    expect(states.get("child")).toEqual({ status: "loaded" })

    await loader.ensure("child")
    expect(calls).toEqual(["child"])
  })

  test("starts different sessions independently", async () => {
    const requests = new Map([
      ["one", deferred()],
      ["two", deferred()],
    ])
    const calls: string[] = []
    const { loader } = setup((sessionID) => {
      calls.push(sessionID)
      return requests.get(sessionID)!.promise
    })

    const loading = Promise.all([loader.ensure("one"), loader.ensure("two")])
    await Promise.resolve()
    expect(calls.toSorted()).toEqual(["one", "two"])
    requests.get("one")!.resolve()
    requests.get("two")!.resolve()
    await loading
  })

  test("records failures and allows retry", async () => {
    const calls: string[] = []
    const { loader, states } = setup(async (sessionID) => {
      calls.push(sessionID)
      if (calls.length === 1) throw new Error("offline")
    })

    await expect(loader.ensure("child")).rejects.toThrow("offline")
    expect(states.get("child")).toEqual({ status: "error", error: "offline" })

    await loader.ensure("child")
    expect(calls).toEqual(["child", "child"])
    expect(states.get("child")).toEqual({ status: "loaded" })
  })

  test("does not let an invalidated flight commit data or overwrite a newer loaded state", async () => {
    const request = deferred()
    let committed = false
    const { loader, states } = setup(async (_sessionID, context) => {
      await request.promise
      if (context.isCurrent()) committed = true
    })

    const loading = loader.ensure("child")
    await Promise.resolve()
    loader.loaded("child")
    request.resolve()
    await loading

    expect(committed).toBe(false)
    expect(states.get("child")).toEqual({ status: "loaded" })
  })

  test("ignores an invalidated flight failure", async () => {
    const request = deferred()
    const { loader, states } = setup(() => request.promise)

    const loading = loader.ensure("child")
    await Promise.resolve()
    loader.loaded("child")
    request.reject(new Error("stale failure"))
    await loading

    expect(states.get("child")).toEqual({ status: "loaded" })
  })
})

describe("mergeSessionSnapshot", () => {
  test("uses complete snapshot values for existing ids and retains cached-only live values", () => {
    const snapshot = [
      { id: "message-1", text: "complete" },
      { id: "message-2", text: "history" },
    ]
    const cached = [
      { id: "message-1", text: "partial" },
      { id: "message-3", text: "live" },
    ]

    expect(mergeSessionSnapshot(snapshot, cached)).toEqual([
      { id: "message-1", text: "complete" },
      { id: "message-2", text: "history" },
      { id: "message-3", text: "live" },
    ])
  })

  test("preserves updates and removals that arrived while the snapshot request was running", () => {
    const snapshot = [
      { id: "message-1", text: "running" },
      { id: "message-2", text: "stale" },
      { id: "message-3", text: "history" },
    ]
    const cached = [
      { id: "message-1", text: "completed" },
      { id: "message-3", text: "history" },
      { id: "message-4", text: "new live message" },
    ]

    expect(
      mergeSessionSnapshot(snapshot, cached, (id) => id === "message-1" || id === "message-2" || id === "message-4"),
    ).toEqual([
      { id: "message-1", text: "completed" },
      { id: "message-3", text: "history" },
      { id: "message-4", text: "new live message" },
    ])
  })

  test("reapplies the loaded message limit after merging", () => {
    const messages = Array.from({ length: 101 }, (_, index) => ({ id: index.toString().padStart(3, "0") }))
    const limited = limitSessionSnapshot(messages, 100)

    expect(limited).toHaveLength(100)
    expect(limited[0]?.id).toBe("001")
    expect(limited.at(-1)?.id).toBe("100")
  })
})
