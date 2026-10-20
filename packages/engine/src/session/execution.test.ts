import { expect, test } from "vitest"
import { AsyncLocalStorage } from "node:async_hooks"
import { SessionExecution } from "./execution"

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

test("interrupt selection follows the active SDK child to its snapshotted parent and excludes stale IDs", () => {
  const parent = SessionExecution.create({ id: "select-parent", sessionID: "selection" })
  const child = SessionExecution.create({ id: "select-child", sessionID: "selection", parent })
  const queued = SessionExecution.create({ id: "select-queued", sessionID: "selection" })
  expect(SessionExecution.select("selection", [parent.id, queued.id], child)).toBe(parent)
  expect(SessionExecution.select("selection", ["finished"], child)).toBeUndefined()
  expect(SessionExecution.select("selection", [], child)).toBeUndefined()
  SessionExecution.finish(child)
  SessionExecution.finish(parent)
  expect(SessionExecution.select("selection", [parent.id])).toBeUndefined()
  expect(SessionExecution.select("selection")).toBe(queued)
  SessionExecution.finish(queued)
})

test("SDK child scopes have independent bindings and inherit parent cancellation", async () => {
  const parent = SessionExecution.create({ id: "parent-sdk", sessionID: "session" })
  const child = SessionExecution.create({ id: "child-sdk", sessionID: "session", parent })
  const calls: string[] = []
  SessionExecution.bind(parent, {
    cancel: () => {
      calls.push("parent")
    },
    done: Promise.resolve(),
  })
  SessionExecution.bind(child, {
    cancel: () => {
      calls.push("child")
    },
    done: Promise.resolve(),
  })
  let settled = false
  const pending = SessionExecution.settleChildren(parent).then(() => {
    settled = true
  })
  await Promise.resolve()
  expect(settled).toBe(false)
  const cancellation = SessionExecution.cancel("session", [parent.id])
  expect(child.controller.signal.aborted).toBe(true)
  expect(calls).toEqual(["parent", "child"])
  expect(() => SessionExecution.create({ id: "late-child", sessionID: "session", parent })).toThrow()
  SessionExecution.finish(child)
  await pending
  expect(settled).toBe(true)
  SessionExecution.finish(parent)
  await cancellation
})

test("cancelling a stuck SDK child has a bounded settlement and blocks late callbacks", async () => {
  const parent = SessionExecution.create({ id: "bounded-parent", sessionID: "session" })
  const child = SessionExecution.create({ id: "bounded-child", sessionID: "session", parent })
  const never = new Promise<void>(() => {})
  SessionExecution.bind(child, { cancel: () => never, done: never })
  const started = Date.now()
  await SessionExecution.cancel("session", [parent.id])
  expect(Date.now() - started).toBeLessThan(4_500)
  SessionExecution.finish(parent)
  expect(() => SessionExecution.create({ id: "bounded-late", sessionID: "session", parent })).toThrow()
  SessionExecution.finish(child)
}, 5_000)

test("preparation cancellation rejects immediately and consumes a late failure", async () => {
  const scope = SessionExecution.create({ id: "prepare", sessionID: "session" })
  const gate = deferred<string>()
  let continued = false
  const pending = SessionExecution.run(scope, async () => {
    await SessionExecution.wait(() => gate.promise)
    continued = true
  }).finally(() => SessionExecution.finish(scope))
  void pending.catch(() => {})
  const cancelled = SessionExecution.cancel("session", [scope.id])
  await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  await cancelled
  gate.reject(new Error("late plugin failure"))
  await Promise.resolve()
  expect(continued).toBe(false)
})

test("cancel snapshots matching request identities before a new request is registered", async () => {
  const first = SessionExecution.create({ id: "first", sessionID: "session" })
  const other = SessionExecution.create({ id: "other", sessionID: "another-session" })
  const cancelled = SessionExecution.cancel("session", [first.id, other.id])
  const next = SessionExecution.create({ id: "next", sessionID: "session" })
  expect(first.controller.signal.aborted).toBe(true)
  expect(other.controller.signal.aborted).toBe(false)
  expect(next.controller.signal.aborted).toBe(false)
  for (const scope of [first, other, next]) SessionExecution.finish(scope)
  await cancelled
})

test("binding captures execution context and stale cleanup cannot detach its replacement", async () => {
  const context = new AsyncLocalStorage<string>()
  const scope = SessionExecution.create({ id: "bind", sessionID: "session" })
  const calls: string[] = []
  const old = SessionExecution.bind(scope, {
    cancel: () => {
      calls.push("old")
    },
    done: Promise.resolve(),
  })
  context.run("instance", () =>
    SessionExecution.bind(scope, {
      cancel: () => {
        calls.push(context.getStore()!)
      },
      done: Promise.resolve(),
    }),
  )
  old()
  const cancelled = SessionExecution.cancel("session", [scope.id])
  SessionExecution.finish(scope)
  await cancelled
  expect(calls).toEqual(["instance"])
})

test("finished and unbound requests cannot cancel a successor's loop", async () => {
  const previous = SessionExecution.create({ id: "previous", sessionID: "session" })
  let calls = 0
  const unbind = SessionExecution.bind(previous, {
    cancel: () => {
      calls++
    },
    done: Promise.resolve(),
  })
  unbind()
  SessionExecution.finish(previous)
  const next = SessionExecution.create({ id: "successor", sessionID: "session" })
  SessionExecution.bind(next, {
    cancel: () => {
      calls++
    },
    done: Promise.resolve(),
  })
  await SessionExecution.cancel("session", [previous.id])
  expect(calls).toBe(0)
  expect(next.controller.signal.aborted).toBe(false)
  SessionExecution.finish(next)
})

test("scope matching and explicit context isolation protect nested sessions", async () => {
  const scope = SessionExecution.create({ id: "nested", sessionID: "session" })
  await SessionExecution.run(scope, async () => {
    expect(SessionExecution.current("session")).toBe(scope)
    expect(SessionExecution.current("child")).toBeUndefined()
    await SessionExecution.run(undefined, async () => {
      expect(SessionExecution.current()).toBeUndefined()
      expect(await SessionExecution.wait(() => "legacy result")).toBe("legacy result")
    })
    expect(SessionExecution.current()).toBe(scope)
  })
  SessionExecution.finish(scope)
})

test("an already cancelled request cannot start an operation or bind a loop", async () => {
  const scope = SessionExecution.create({ id: "cancelled", sessionID: "session" })
  const cancelled = SessionExecution.cancel("session", [scope.id])
  let starts = 0
  expect(() => SessionExecution.run(scope, () => SessionExecution.wait(() => starts++))).toThrow()
  expect(() => SessionExecution.bind(scope, { cancel() {}, done: Promise.resolve() })).toThrow()
  expect(starts).toBe(0)
  SessionExecution.finish(scope)
  await cancelled
})

test("cancellation waits for loop reconciliation and prepared-message cleanup after request completion", async () => {
  const scope = SessionExecution.create({ id: "reconcile", sessionID: "session" })
  const loop = deferred()
  const storage = deferred()
  SessionExecution.bind(scope, { cancel: () => loop.promise, done: Promise.resolve() })
  SessionExecution.onCancel(scope, () => storage.promise)
  let acknowledged = false
  const cancelled = SessionExecution.cancel("session", [scope.id]).then(() => {
    acknowledged = true
  })
  SessionExecution.finish(scope)
  await Promise.resolve()
  expect(acknowledged).toBe(false)
  loop.resolve()
  await Promise.resolve()
  expect(acknowledged).toBe(false)
  storage.resolve()
  await cancelled
  expect(acknowledged).toBe(true)
})
