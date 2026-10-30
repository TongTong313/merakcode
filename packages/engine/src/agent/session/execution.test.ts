import { expect, test } from "vitest"
import { AsyncLocalStorage } from "node:async_hooks"
import { LoopExecution } from "../loop/execution"

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
  const parent = LoopExecution.create({ id: "select-parent", sessionID: "selection" })
  const child = LoopExecution.create({ id: "select-child", sessionID: "selection", parent })
  const queued = LoopExecution.create({ id: "select-queued", sessionID: "selection" })
  expect(LoopExecution.select("selection", [parent.id, queued.id], child)).toBe(parent)
  expect(LoopExecution.select("selection", ["finished"], child)).toBeUndefined()
  expect(LoopExecution.select("selection", [], child)).toBeUndefined()
  LoopExecution.finish(child)
  LoopExecution.finish(parent)
  expect(LoopExecution.select("selection", [parent.id])).toBeUndefined()
  expect(LoopExecution.select("selection")).toBe(queued)
  LoopExecution.finish(queued)
})

test("SDK child scopes have independent bindings and inherit parent cancellation", async () => {
  const parent = LoopExecution.create({ id: "parent-sdk", sessionID: "session" })
  const child = LoopExecution.create({ id: "child-sdk", sessionID: "session", parent })
  const calls: string[] = []
  LoopExecution.bind(parent, {
    cancel: () => {
      calls.push("parent")
    },
    done: Promise.resolve(),
  })
  LoopExecution.bind(child, {
    cancel: () => {
      calls.push("child")
    },
    done: Promise.resolve(),
  })
  let settled = false
  const pending = LoopExecution.settleChildren(parent).then(() => {
    settled = true
  })
  await Promise.resolve()
  expect(settled).toBe(false)
  const cancellation = LoopExecution.cancel("session", [parent.id])
  expect(child.controller.signal.aborted).toBe(true)
  expect(calls).toEqual(["parent", "child"])
  expect(() => LoopExecution.create({ id: "late-child", sessionID: "session", parent })).toThrow()
  LoopExecution.finish(child)
  await pending
  expect(settled).toBe(true)
  LoopExecution.finish(parent)
  await cancellation
})

test("cancelling a stuck SDK child has a bounded settlement and blocks late callbacks", async () => {
  const parent = LoopExecution.create({ id: "bounded-parent", sessionID: "session" })
  const child = LoopExecution.create({ id: "bounded-child", sessionID: "session", parent })
  const never = new Promise<void>(() => {})
  LoopExecution.bind(child, { cancel: () => never, done: never })
  const started = Date.now()
  await LoopExecution.cancel("session", [parent.id])
  expect(Date.now() - started).toBeLessThan(4_500)
  LoopExecution.finish(parent)
  expect(() => LoopExecution.create({ id: "bounded-late", sessionID: "session", parent })).toThrow()
  LoopExecution.finish(child)
}, 5_000)

test("preparation cancellation rejects immediately and consumes a late failure", async () => {
  const scope = LoopExecution.create({ id: "prepare", sessionID: "session" })
  const gate = deferred<string>()
  let continued = false
  const pending = LoopExecution.run(scope, async () => {
    await LoopExecution.wait(() => gate.promise)
    continued = true
  }).finally(() => LoopExecution.finish(scope))
  void pending.catch(() => {})
  const cancelled = LoopExecution.cancel("session", [scope.id])
  await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  await cancelled
  gate.reject(new Error("late plugin failure"))
  await Promise.resolve()
  expect(continued).toBe(false)
})

test("cancel snapshots matching request identities before a new request is registered", async () => {
  const first = LoopExecution.create({ id: "first", sessionID: "session" })
  const other = LoopExecution.create({ id: "other", sessionID: "another-session" })
  const cancelled = LoopExecution.cancel("session", [first.id, other.id])
  const next = LoopExecution.create({ id: "next", sessionID: "session" })
  expect(first.controller.signal.aborted).toBe(true)
  expect(other.controller.signal.aborted).toBe(false)
  expect(next.controller.signal.aborted).toBe(false)
  for (const scope of [first, other, next]) LoopExecution.finish(scope)
  await cancelled
})

test("binding captures execution context and stale cleanup cannot detach its replacement", async () => {
  const context = new AsyncLocalStorage<string>()
  const scope = LoopExecution.create({ id: "bind", sessionID: "session" })
  const calls: string[] = []
  const old = LoopExecution.bind(scope, {
    cancel: () => {
      calls.push("old")
    },
    done: Promise.resolve(),
  })
  context.run("instance", () =>
    LoopExecution.bind(scope, {
      cancel: () => {
        calls.push(context.getStore()!)
      },
      done: Promise.resolve(),
    }),
  )
  old()
  const cancelled = LoopExecution.cancel("session", [scope.id])
  LoopExecution.finish(scope)
  await cancelled
  expect(calls).toEqual(["instance"])
})

test("finished and unbound requests cannot cancel a successor's loop", async () => {
  const previous = LoopExecution.create({ id: "previous", sessionID: "session" })
  let calls = 0
  const unbind = LoopExecution.bind(previous, {
    cancel: () => {
      calls++
    },
    done: Promise.resolve(),
  })
  unbind()
  LoopExecution.finish(previous)
  const next = LoopExecution.create({ id: "successor", sessionID: "session" })
  LoopExecution.bind(next, {
    cancel: () => {
      calls++
    },
    done: Promise.resolve(),
  })
  await LoopExecution.cancel("session", [previous.id])
  expect(calls).toBe(0)
  expect(next.controller.signal.aborted).toBe(false)
  LoopExecution.finish(next)
})

test("scope matching and explicit context isolation protect nested sessions", async () => {
  const scope = LoopExecution.create({ id: "nested", sessionID: "session" })
  await LoopExecution.run(scope, async () => {
    expect(LoopExecution.current("session")).toBe(scope)
    expect(LoopExecution.current("child")).toBeUndefined()
    await LoopExecution.run(undefined, async () => {
      expect(LoopExecution.current()).toBeUndefined()
      expect(await LoopExecution.wait(() => "legacy result")).toBe("legacy result")
    })
    expect(LoopExecution.current()).toBe(scope)
  })
  LoopExecution.finish(scope)
})

test("an already cancelled request cannot start an operation or bind a loop", async () => {
  const scope = LoopExecution.create({ id: "cancelled", sessionID: "session" })
  const cancelled = LoopExecution.cancel("session", [scope.id])
  let starts = 0
  expect(() => LoopExecution.run(scope, () => LoopExecution.wait(() => starts++))).toThrow()
  expect(() => LoopExecution.bind(scope, { cancel() {}, done: Promise.resolve() })).toThrow()
  expect(starts).toBe(0)
  LoopExecution.finish(scope)
  await cancelled
})

test("cancellation waits for loop reconciliation and prepared-message cleanup after request completion", async () => {
  const scope = LoopExecution.create({ id: "reconcile", sessionID: "session" })
  const loop = deferred()
  const storage = deferred()
  LoopExecution.bind(scope, { cancel: () => loop.promise, done: Promise.resolve() })
  LoopExecution.onCancel(scope, () => storage.promise)
  let acknowledged = false
  const cancelled = LoopExecution.cancel("session", [scope.id]).then(() => {
    acknowledged = true
  })
  LoopExecution.finish(scope)
  await Promise.resolve()
  expect(acknowledged).toBe(false)
  loop.resolve()
  await Promise.resolve()
  expect(acknowledged).toBe(false)
  storage.resolve()
  await cancelled
  expect(acknowledged).toBe(true)
})
