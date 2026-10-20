import type { Event, GlobalEvent } from "@merakcode/sdk/client"
import { Log } from "@merakcode/log/logger"
import { useProject } from "./project"
import { useSDK } from "./sdk"

/**
 * Event delivery.
 *
 * An event's `directory` is the Instance directory of its session, which need not be the TUI's launch directory: a
 * session created in another directory (`Session.create` uses the working directory at creation) produces events
 * whose directory does not match. Those events may belong to a session this TUI just started and must be delivered,
 * otherwise its message.updated / message.part.updated events are lost (messages never appear, ESC does not roll back).
 *
 * Ownership is decided by the sessionID in the payload, and every consumer already checks its own session context
 * (opencode does the same and treats directory as metadata only). So events are never dropped by directory; the pure
 * helpers below exist only for diagnostics and regression tests.
 */

/** Normalizes a directory for comparison: trims whitespace, unifies separators, drops trailing separators. */
function normalize(input: string): string {
  return input.trim().replace(/\\/g, "/").replace(/\/+$/, "")
}

/**
 * Whether the event directory differs from the current directory.
 *
 * - `global` is the fixed directory of process-level events (`publishGlobal`); it belongs to no project and never
 *   counts as foreign.
 * - Windows paths are case-insensitive, so the comparison is too; otherwise drive letter or casing differences would
 *   make the same directory look foreign.
 */
export function isForeignDirectory(event: Pick<GlobalEvent, "directory">, current: string): boolean {
  const directory = event.directory
  if (!directory) return false
  if (directory === "global") return false
  return normalize(directory).toLowerCase() !== normalize(current).toLowerCase()
}

/**
 * Each foreign directory is reported once to avoid flooding the log while streaming. The directory itself is never
 * logged (it may contain personal data such as the user name); only the event type and session id are.
 */
const reported = new Set<string>()

function reportForeign(event: GlobalEvent) {
  const payload = event.payload as { type?: string; properties?: Record<string, unknown> }
  const sessionID = payload?.properties?.["sessionID"]
  const key = normalize(event.directory).toLowerCase()
  if (reported.has(key)) return
  reported.add(key)
  Log.create({ source: "product", service: "tui.event" }).info("delivering event from another directory", {
    type: payload?.type,
    sessionID: typeof sessionID === "string" ? sessionID : undefined,
    directoryMatched: false,
  })
}

/** Resets the report-once state; for tests only. */
export function resetForeignEventReports() {
  reported.clear()
}

/**
 * Unwraps a raw GlobalEvent and passes the Event to the handler.
 *
 * **Nothing is dropped here**; this is the module's core invariant. An event's directory is its session's directory
 * and may legitimately differ from the TUI's launch directory, so only the handler can decide by sessionID. Kept as a
 * pure function so regression tests can pin the invariant without a Solid context.
 */
export function wrapGlobalEvent(handler: (event: Event) => void, current: () => string) {
  return (globalEvent: GlobalEvent) => {
    if (isForeignDirectory(globalEvent, current())) reportForeign(globalEvent)
    handler(globalEvent.payload)
  }
}

/**
 * useEvent — global event consumption hook
 *
 * Subscribes to the GlobalEvent stream and dispatches by type. Events are **not filtered by directory**: an event's
 * directory is that of the session that published it and may differ from the TUI's launch directory (see the module
 * comment). `isForeignDirectory` only drives a diagnostic log entry for such events.
 */
export function useEvent() {
  const project = useProject()
  const sdk = useSDK()

  /**
   * Subscribes to the raw GlobalEvent stream, logs directory diagnostics and passes unwrapped events to the caller.
   * @param handler receives the unwrapped Event
   * @returns a function that unsubscribes
   */
  function subscribe(handler: (event: Event) => void) {
    return sdk.event.on("event", wrapGlobalEvent(handler, project.directory))
  }

  /**
   * Subscribes to a single event type on top of `subscribe`.
   */
  function on<T extends Event["type"]>(type: T, handler: (event: Extract<Event, { type: T }>) => void) {
    return subscribe((event) => {
      if (event.type !== type) return
      handler(event as Extract<Event, { type: T }>)
    })
  }

  return { subscribe, on }
}
