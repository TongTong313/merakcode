import { AsyncLocalStorage } from "node:async_hooks"
import { createRequire } from "node:module"
import path from "node:path"
import { Log } from "@merakcode/log/logger"
import { lazy } from "@merakcode/util/lazy"

const log = Log.create({ service: "parcel.binding" })

type Watcher = typeof import("@parcel/watcher")
type Subscription = Awaited<ReturnType<Watcher["subscribe"]>>

/** Subscriptions not yet cancelled; all must be cancelled before exit (see closeParcelWatchers) */
const active = new Set<Subscription>()

/**
 * Cancelling a native subscription while its directory still produces events crashes on Windows and macOS:
 * - Windows has a use-after-free (parcel-bundler/watcher#262, still in 2.6.0): after the subscription is freed, the
 *   completion callback of the pending directory read in the kernel still reads it. When the watcher is busy handling
 *   events (allocating memory), the freed memory is reused quickly and the process crashes (0xC0000005).
 * - On macOS the FSEvents callback runs on the watcher's own thread and reads the subscription state without a lock,
 *   while a cancel from the JS thread stops the stream and clears that state, so the two race (SIGSEGV, exit 139).
 * Every config write rebuilds the instance, cancels and resubscribes the config directory, and the write itself
 * produces events, which triggers exactly this.
 * So on both, cancelling first stops the callback and queues the native cancel; queued cancels run one by one once
 * no watcher has had events for QUIET_MS. Linux cancels immediately.
 * Quiet has to be measured on everything the native watcher handles: it reports steady changes only every 500 ms, and
 * changes in ignored paths keep it just as busy without ever reaching the callback. So QUIET_MS is longer than that
 * interval, and on these systems plain ignored paths are filtered here instead of natively (see splitIgnore).
 */
const deferred = process.platform === "win32" || process.platform === "darwin"
/** Windows only: exiting with live subscriptions is safe there, while a native cancel during exit crashes */
const leaveAtExit = process.platform === "win32"
const QUIET_MS = 1_000
/** Maximum wait before exit for queued cancels; then Windows leaves the rest to the process exit, macOS cancels them */
const EXIT_WAIT_MS = 2_000
/**
 * Time of the latest subscribe or of any event: after subscribing the directory may already be changing, with events
 * not yet delivered
 */
let last = 0
/** Native subscriptions queued for cancellation */
const pending: Subscription[] = []
let draining: Promise<void> | undefined
/** Set by closeParcelWatchers: on Windows no new native cancel starts once the process is on its way out */
let exiting = false

function drain() {
  draining ??= (async () => {
    while (pending.length > 0 && !(exiting && leaveAtExit)) {
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
      const split = splitIgnore(dir, options)
      let closed = false
      last = Date.now()
      const inner = await binding.subscribe(
        dir,
        (error, events) => {
          last = Date.now()
          if (closed) return
          const kept = events.filter((event) => !split.ignored(event.path))
          if (!error && events.length > 0 && kept.length === 0) return
          within(() => callback(error, kept))
        },
        split.options,
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

/** Names and relative paths without glob characters, which @parcel/watcher matches as paths rather than globs */
const PLAIN_PATH = /^[\w. -]+(?:[\\/][\w. -]+)*$/

/**
 * On Windows and macOS takes the plain paths out of the native ignore list and matches them here the way the native
 * module does (the path itself or anything under it), so their changes still count as events (see QUIET_MS). Globs and
 * regular expressions stay native.
 */
function splitIgnore(dir: string, options: Parameters<Watcher["subscribe"]>[2]) {
  const ignore = options?.ignore
  if (!deferred || !ignore) return { options, ignored: (_: string) => false }
  const plain = ignore.filter((entry): entry is string => typeof entry === "string" && PLAIN_PATH.test(entry))
  const roots = plain.map((entry) => path.resolve(dir, entry))
  return {
    options: { ...options, ignore: ignore.filter((entry) => !plain.includes(entry as string)) },
    ignored: (file: string) => roots.some((root) => file === root || file.startsWith(root + path.sep)),
  }
}

export function activeParcelWatchers() {
  return active.size
}

/** Native cancels queued until the watchers are quiet (Windows and macOS) */
export function pendingParcelCancels() {
  return pending.length
}

/**
 * Stops every subscription; call once, right before the process exits.
 * - Linux cancels natively right away: exiting with live subscriptions makes the inotify backend free memory twice in
 *   static destructors (exit 134).
 * - macOS waits up to EXIT_WAIT_MS for the queued cancels to run once the directories are quiet, then cancels the rest
 *   immediately: nothing shows that exiting with live FSEvents streams is safe.
 * - Windows is the opposite of Linux: a native cancel while the directory is busy crashes, while exiting with live
 *   subscriptions does not, so callbacks stop, no new native cancel starts, and only a cancel that is already running
 *   is awaited (exiting in the middle of it crashes too). The caller must then exit the process (process.exit), since
 *   the subscriptions left open on Windows keep it alive.
 */
export async function closeParcelWatchers() {
  exiting = true
  await Promise.all([...active].map((subscription) => subscription.unsubscribe().catch(() => undefined)))
  if (draining) await Promise.race([draining, new Promise((resolve) => setTimeout(resolve, EXIT_WAIT_MS).unref())])
  if (leaveAtExit) return
  const rest = pending.splice(0)
  await Promise.all(rest.map((inner) => inner.unsubscribe().catch(() => undefined)))
  await draining
}

export function parcelWatcherBackend(): "windows" | "fs-events" | "inotify" | undefined {
  if (process.platform === "win32") return "windows"
  if (process.platform === "darwin") return "fs-events"
  if (process.platform === "linux") return "inotify"
  return undefined
}
