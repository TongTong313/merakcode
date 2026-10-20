import { AsyncLocalStorage } from "node:async_hooks"
import { createRequire } from "node:module"
import { Log } from "@merakcode/log/logger"
import { lazy } from "../util/lazy"

const log = Log.create({ service: "parcel.binding" })

type Watcher = typeof import("@parcel/watcher")
type Subscription = Awaited<ReturnType<Watcher["subscribe"]>>

/** Subscriptions not yet cancelled; all must be cancelled before exit (see closeParcelWatchers) */
const active = new Set<Subscription>()

/**
 * Cancelling a native subscription on Windows has a use-after-free bug (parcel-bundler/watcher#262, still in 2.6.0):
 * after the subscription is freed, the completion callback of the pending directory read in the kernel still reads
 * it. When the watcher is busy handling events (allocating memory), the freed memory is reused quickly and the
 * process crashes (0xC0000005). Every config write rebuilds the instance, cancels and resubscribes the config
 * directory, and the write itself produces events, which triggers exactly this.
 * So on Windows, cancelling first stops the callback and queues the native cancel; queued cancels run one by one once
 * no watcher has had events for QUIET_MS. Linux and macOS cancel immediately.
 */
const deferred = process.platform === "win32"
const QUIET_MS = 200
/** Maximum wait before exit; subscriptions still pending end with the process (safe on Windows) */
const EXIT_WAIT_MS = 2_000
/**
 * Time of the latest subscribe or of any event: after subscribing the directory may already be changing, with events
 * not yet delivered
 */
let last = 0
/** Native subscriptions queued for cancellation */
const pending: Subscription[] = []
let draining: Promise<void> | undefined

function drain() {
  draining ??= (async () => {
    while (pending.length > 0) {
      const quiet = Date.now() - last
      if (quiet < QUIET_MS) {
        await new Promise((resolve) => setTimeout(resolve, QUIET_MS - quiet))
        continue
      }
      await pending
        .shift()!
        .unsubscribe()
        .catch((error) => log.error("failed to unsubscribe watcher", { error }))
    }
  })().finally(() => (draining = undefined))
  return draining
}

/**
 * Native @parcel/watcher binding (Windows / macOS / Linux glibc+musl).
 * @parcel/watcher picks the platform package by platform and libc; if loading fails (unsupported platform), file
 * watching falls back to polling. Every subscription is tracked and removed from tracking when cancelled; callbacks
 * run in the subscriber's context and stop after cancellation.
 */
export const parcelWatcher = lazy((): Watcher | undefined => {
  const binding = (() => {
    try {
      return createRequire(import.meta.url)("@parcel/watcher") as Watcher
    } catch (error) {
      log.error("failed to load watcher binding", { error })
      return undefined
    }
  })()
  if (!binding) return undefined
  return {
    ...binding,
    subscribe: async (...[dir, callback, options]: Parameters<Watcher["subscribe"]>) => {
      // Native callbacks lose the AsyncLocalStorage context of the subscriber (instance and request); capture it on
      // subscribe and restore it in the callback
      const within = AsyncLocalStorage.snapshot()
      let closed = false
      last = Date.now()
      const inner = await binding.subscribe(
        dir,
        (error, events) => {
          last = Date.now()
          if (!closed) within(() => callback(error, events))
        },
        options,
      )
      const subscription: Subscription = {
        unsubscribe: () => {
          if (!active.delete(subscription)) return Promise.resolve()
          closed = true
          if (!deferred) return inner.unsubscribe()
          pending.push(inner)
          void drain()
          return Promise.resolve()
        },
      }
      active.add(subscription)
      return subscription
    },
  }
})

export function activeParcelWatchers() {
  return active.size
}

/**
 * Cancels all remaining subscriptions. Call before the process exits: exiting with live subscriptions on Linux makes
 * the inotify backend free memory twice in static destructors, crashing with 134 (double free). On Windows, queued
 * cancels get at most EXIT_WAIT_MS.
 */
export async function closeParcelWatchers() {
  await Promise.all([...active].map((subscription) => subscription.unsubscribe().catch(() => undefined)))
  if (pending.length > 0)
    await Promise.race([drain(), new Promise((resolve) => setTimeout(resolve, EXIT_WAIT_MS).unref())])
}

export function parcelWatcherBackend(): "windows" | "fs-events" | "inotify" | undefined {
  if (process.platform === "win32") return "windows"
  if (process.platform === "darwin") return "fs-events"
  if (process.platform === "linux") return "inotify"
  return undefined
}
