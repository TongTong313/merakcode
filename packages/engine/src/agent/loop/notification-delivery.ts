import { Bus } from "../../infra/bus"
import { Instance } from "../../infra/project/instance"
import { SessionNotification } from "../session/notification"
import { Loop } from "./index"
import { LoopStatus } from "./status"
import { LoopExecution } from "./execution"

export namespace SessionNotificationDelivery {
  const RETRY_MS = 1000
  const MAX_RETRY_MS = 60_000

  const state = Instance.state(
    () => {
      const entries: Record<
        string,
        {
          timer?: ReturnType<typeof setTimeout>
          running?: boolean
        }
      > = {}
      return {
        entries,
        created: Bus.subscribe(SessionNotification.Event.Created, (event) => {
          request(event.properties.sessionID)
        }),
        status: Bus.subscribe(LoopStatus.Event.Status, (event) => {
          if (event.properties.status.type !== "idle") return
          request(event.properties.sessionID, { delay: 0 })
        }),
      }
    },
    async (current) => {
      current.created()
      current.status()
      for (const entry of Object.values(current.entries)) {
        if (entry.timer) clearTimeout(entry.timer)
      }
    },
  )

  export function request(sessionID: string, options?: { delay?: number }) {
    const current = state().entries[sessionID] ?? {}
    state().entries[sessionID] = current
    if (current.timer) {
      if (options?.delay !== 0) return
      clearTimeout(current.timer)
      current.timer = undefined
    }
    current.timer = setTimeout(() => {
      current.timer = undefined
      // Delivery is an independent background turn, not a continuation of the
      // request that created the notification (which may already be cancelled).
      void LoopExecution.run(undefined, () => attempt(sessionID))
    }, options?.delay ?? RETRY_MS)
  }

  async function attempt(sessionID: string) {
    const current = state().entries[sessionID] ?? {}
    state().entries[sessionID] = current
    if (current.running) return
    const pending = await SessionNotification.list(sessionID)
    if (pending.length === 0) {
      delete state().entries[sessionID]
      return
    }
    if (LoopStatus.get(sessionID).type !== "idle") {
      request(sessionID, { delay: retryDelay(pending) })
      return
    }

    current.running = true
    try {
      Loop.assertNotBusy(sessionID)
      await Loop.run({ sessionID })
    } catch {
      request(sessionID, { delay: retryDelay(await SessionNotification.list(sessionID)) })
    } finally {
      const next = state().entries[sessionID]
      if (next) next.running = false
    }

    if ((await SessionNotification.list(sessionID)).length === 0) {
      const next = state().entries[sessionID]
      if (next?.timer) clearTimeout(next.timer)
      delete state().entries[sessionID]
      return
    }
    request(sessionID, { delay: retryDelay(await SessionNotification.list(sessionID)) })
  }

  function retryDelay(notifications: SessionNotification.Info[]) {
    const attempts = Math.max(0, ...notifications.map((item) => item.attempts ?? 0))
    return Math.min(MAX_RETRY_MS, RETRY_MS * Math.max(1, 2 ** attempts))
  }
}
