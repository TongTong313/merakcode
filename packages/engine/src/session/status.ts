import { BusEvent } from "../bus/bus-event"
import { Bus } from "../bus"
import { Instance } from "../project/instance"
import z from "zod"

export namespace SessionStatus {
  export const Info = z
    .union([
      z.object({
        type: z.literal("idle"),
      }),
      z.object({
        type: z.literal("retry"),
        attempt: z.number(),
        message: z.string(),
        next: z.number(),
      }),
      z.object({
        type: z.literal("busy"),
      }),
    ])
    .meta({
      ref: "SessionStatus",
    })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Status: BusEvent.define(
      "session.status",
      z.object({
        sessionID: z.string(),
        status: Info,
      }),
    ),
    // deprecated
    Idle: BusEvent.define(
      "session.idle",
      z.object({
        sessionID: z.string(),
      }),
    ),
  }

  const state = Instance.state(() => {
    const data: Record<string, Info> = {}
    return data
  })

  const requests = Instance.state(() => new Map<string, Set<symbol>>())
  const delivery = Instance.state(() => ({
    publishing: false,
    queue: [] as Array<{ sessionID: string; status: Info; idle: boolean }>,
  }))

  function publish(sessionID: string, status: Info, idle = false) {
    const current = delivery()
    current.queue.push({ sessionID, status, idle })
    if (current.publishing) return
    current.publishing = true
    try {
      for (let next = current.queue.shift(); next; next = current.queue.shift()) {
        // Bus invokes typed, wildcard and global subscribers synchronously in
        // that order. Reentrant transitions must wait until all observers have
        // received this transition, or an old idle can arrive after a new busy.
        Bus.publish(Event.Status, { sessionID: next.sessionID, status: next.status })
        if (next.idle && !state()[next.sessionID] && !requests().get(next.sessionID)?.size)
          Bus.publish(Event.Idle, { sessionID: next.sessionID })
      }
    } finally {
      current.publishing = false
    }
  }

  /** Keep preparation busy even when another local loop finishes concurrently. */
  export function hold(sessionID: string) {
    const current = requests()
    const holders = current.get(sessionID) ?? new Set<symbol>()
    const identity = Symbol()
    holders.add(identity)
    current.set(sessionID, holders)
    return () => {
      holders.delete(identity)
      if (!holders.size && current.get(sessionID) === holders) current.delete(sessionID)
    }
  }

  export function get(sessionID: string) {
    return (
      state()[sessionID] ?? {
        type: "idle",
      }
    )
  }

  export function list() {
    return state()
  }

  export function set(sessionID: string, status: Info) {
    const data = state()
    // idle is idempotent: nothing is published when there is no entry or it is already idle. cancel(), processor
    // abort cleanup and undo's cancelTree can all set idle in a row; without this the desktop app would show a
    // "reply ready" notification for each session.idle.
    if (status.type === "idle") {
      if (requests().get(sessionID)?.size) return
      const prev = data[sessionID]
      if (!prev || prev.type === "idle") {
        delete data[sessionID]
        return
      }
      // Subscribers may synchronously submit a new request. Commit the old idle
      // before notifying them so it cannot delete that new request's busy state.
      delete data[sessionID]
      publish(sessionID, status, true)
      return
    }
    data[sessionID] = status
    publish(sessionID, status)
  }

  /**
   * Completion for synchronous paths that do not run the loop.
   * - Was busy/retry: same as set(idle), publishes status and session.idle
   * - Never busy: publishes only session.status idle, not session.idle
   *   The desktop "reply ready" notification listens only to session.idle.
   * cancel and undo still use set(idle), so idle sessions stay silent.
   */
  export function finishSync(sessionID: string) {
    if (requests().get(sessionID)?.size) return
    const prev = state()[sessionID]
    if (prev && prev.type !== "idle") {
      set(sessionID, { type: "idle" })
      return
    }
    publish(sessionID, { type: "idle" })
  }
}
