import { AsyncLocalStorage } from "node:async_hooks"
import { Checkout } from "../project/checkout"
import { Instance } from "../project/instance"
import { LOOP_STOP_TIMEOUT_MS } from "./cancel-tree"

/** Trusted, process-local request state. Never accepted from an HTTP payload. */
export namespace SessionExecution {
  type Binding = { cancel(): void | Promise<void>; done: Promise<void> }

  export type Scope = {
    readonly id: string
    readonly sessionID: string
    readonly controller: AbortController
    readonly done: Promise<void>
  }

  type Entry = Scope & {
    resolve(): void
    binding?: Binding
    cleanups: Set<() => Promise<void>>
    finished: boolean
    parent?: Entry
    children: Set<Entry>
  }
  const context = new AsyncLocalStorage<Scope | undefined>()
  const entries = new Map<string, Entry>()

  export function create(input: { id: string; sessionID: string; parent?: Scope }): Scope {
    if (entries.has(input.id)) throw new Error(`Duplicate execution request: ${input.id}`)
    input.parent?.controller.signal.throwIfAborted()
    const parent =
      input.parent && entries.get(input.parent.id) === input.parent ? entries.get(input.parent.id) : undefined
    let resolve!: () => void
    const entry: Entry = {
      id: input.id,
      sessionID: input.sessionID,
      controller: new AbortController(),
      done: new Promise<void>((done) => (resolve = done)),
      resolve: () => resolve(),
      cleanups: new Set(),
      finished: false,
      parent,
      children: new Set(),
    }
    entries.set(entry.id, entry)
    parent?.children.add(entry)
    return entry
  }

  export function run<T>(scope: Scope | undefined, fn: () => T): T {
    return context.run(scope, fn)
  }

  export function current(sessionID?: string): Scope | undefined {
    const scope = context.getStore()
    return scope && (!sessionID || scope.sessionID === sessionID) ? scope : undefined
  }

  export function active(scope: Scope): boolean {
    return entries.get(scope.id) === scope
  }

  /** Select the current request's accepted ancestor, or the first preparation. */
  export function select(sessionID: string, requestIDs?: readonly string[], current?: Scope): Scope | undefined {
    const ids = requestIDs && new Set(requestIDs)
    if (current) {
      let entry = entries.get(current.id)
      let selected: Entry | undefined
      while (entry && entry.sessionID === sessionID) {
        if (entries.get(entry.id) === entry && !entry.controller.signal.aborted && (!ids || ids.has(entry.id)))
          selected = entry
        entry = entry.parent
      }
      return selected
    }
    return [...entries.values()].find(
      (entry) => entry.sessionID === sessionID && !entry.controller.signal.aborted && (!ids || ids.has(entry.id)),
    )
  }

  export function check(sessionID?: string) {
    current(sessionID)?.controller.signal.throwIfAborted()
  }

  /** Consume late results/errors without letting a cancelled preparation continue. */
  export function wait<T>(fn: () => T | PromiseLike<T>, sessionID?: string): Promise<T> {
    const scope = current(sessionID)
    if (!scope) return Promise.resolve(fn())
    const signal = scope.controller.signal
    signal.throwIfAborted()
    const releaseCheckout = Instance.has() ? Checkout.hold() : () => {}
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener("abort", abort, { once: true })
      // Invoke synchronously after attaching the listener: cancellation and startup
      // cannot slip between the check and ownership of this operation.
      let pending: T | PromiseLike<T>
      try {
        pending = fn()
      } catch (error) {
        releaseCheckout()
        signal.removeEventListener("abort", abort)
        reject(error)
        return
      }
      Promise.resolve(pending).then(
        (value) => {
          releaseCheckout()
          signal.removeEventListener("abort", abort)
          if (signal.aborted) reject(signal.reason)
          else resolve(value)
        },
        (error) => {
          releaseCheckout()
          signal.removeEventListener("abort", abort)
          reject(signal.aborted ? signal.reason : error)
        },
      )
    })
  }

  /** Bind only the loop actually executing this request; cleanup is identity guarded. */
  export function bind(scope: Scope | undefined, binding: Binding): () => void {
    if (!scope) return () => {}
    scope.controller.signal.throwIfAborted()
    const entry = entries.get(scope.id)
    if (entry !== scope || entry.finished) throw new Error("Execution request is already finished")
    const bound = { done: binding.done, cancel: AsyncLocalStorage.bind(binding.cancel) }
    entry.binding = bound
    return () => {
      if (entry.binding === bound) entry.binding = undefined
    }
  }

  export function finish(scope: Scope) {
    const entry = entries.get(scope.id)
    if (entry !== scope) return
    entry.finished = true
    entry.binding = undefined
    entry.cleanups.clear()
    entries.delete(scope.id)
    entry.parent?.children.delete(entry)
    entry.resolve()
  }

  /** SDK callbacks own their loop bindings while the outer request retains its lease. */
  export async function settleChildren(scope: Scope): Promise<void> {
    for (;;) {
      const children = entries.get(scope.id)?.children
      if (!children?.size) return
      await Promise.all([...children].map((child) => child.done))
    }
  }

  export async function cancelChildren(scope: Scope): Promise<void> {
    const children = [...(entries.get(scope.id)?.children ?? [])]
    await Promise.all(children.map((child) => cancel(child.sessionID, [child.id])))
  }

  /** Register cancellation reconciliation while still owning the request. */
  export function onCancel(scope: Scope | undefined, cleanup: () => Promise<void>) {
    if (!scope) return
    scope.controller.signal.throwIfAborted()
    const entry = entries.get(scope.id)
    if (entry !== scope) throw new Error("Execution request is already finished")
    entry.cleanups.add(AsyncLocalStorage.bind(cleanup))
  }

  export function cancel(sessionID: string, requestIDs?: readonly string[]): Promise<void> {
    const ids = requestIDs ? new Set(requestIDs) : undefined
    const selected = [...entries.values()].filter(
      (entry) => entry.sessionID === sessionID && (!ids || ids.has(entry.id)),
    )
    const matching = new Set<Entry>()
    const include = (entry: Entry) => {
      if (matching.has(entry)) return
      matching.add(entry)
      for (const child of entry.children) include(child)
    }
    selected.forEach(include)
    const done: Promise<void>[] = []
    for (const entry of matching) {
      const binding = entry.binding
      done.push(entry.done)
      if (binding) done.push(binding.done)
      if (entry.controller.signal.aborted) continue
      entry.controller.abort(new DOMException("Operation aborted by user", "AbortError"))
      const settled = binding?.cancel()
      if (settled) done.push(settled)
      for (const cleanup of entry.cleanups) done.push(cleanup())
    }
    if (!done.length) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, LOOP_STOP_TIMEOUT_MS)
      Promise.allSettled(done).then(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}
