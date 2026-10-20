import { Storage } from "../storage/storage"
import { BusEvent } from "../bus/bus-event"
import { Bus } from "../bus"
import z from "zod"
import { Instance } from "../project/instance"
import type { WorkflowRunCache, WorkflowRunControl, WorkflowRunMetadata, WorkflowRunRecord } from "./types"

export namespace WorkflowState {
  const key = (sessionID: string, runId: string) => ["workflow", sessionID, runId]
  const recordKey = (sessionID: string, runId: string) => ["workflow_run", sessionID, runId]
  // Runs in a terminal status are never overwritten by dispose, so a completed result never becomes aborted
  const TERMINAL_STATUSES = new Set<WorkflowRunMetadata["status"]>(["completed", "failed", "aborted"])
  const active = Instance.state(
    () => {
      const data: Record<string, Record<string, WorkflowRunControl>> = {}
      return data
    },
    async (current) => {
      // On dispose, aborting the controllers is not enough: the runtime's catch writes "aborted" asynchronously and
      // the process may exit first, leaving the run "running" after the session is resumed. So active runs are also
      // persisted as aborted here.
      for (const [sessionID, runs] of Object.entries(current)) {
        for (const [runId, controller] of Object.entries(runs)) {
          controller.abort.abort()
          // Idempotent; runs already in a terminal status keep their completed / failed result
          await updateRun(sessionID, runId, (draft) => {
            if (TERMINAL_STATUSES.has(draft.status)) return
            draft.status = "aborted"
            draft.completedAt = Date.now()
            draft.resumable = true
          }).catch(() => undefined)
        }
      }
    },
  )

  // Hot reload is deferred while workflows run. A config write disposes the Instance, and the disposer above would
  // persist active runs as aborted, killing background workflows. So with active runs the reload is queued and runs
  // once none are left. A real process exit goes through the disposer above, not this path.
  let pendingReload: (() => void) | undefined

  /** Whether this Instance still has active workflow runs (registered and not yet unregistered) */
  export function hasActive(): boolean {
    return Object.values(active()).some((runs) => Object.keys(runs).length > 0)
  }

  function drainPendingReload() {
    if (!pendingReload || hasActive()) return
    const cb = pendingReload
    pendingReload = undefined
    // Wait one tick so completion notices already requested by notifyCompleted start first (they are persisted and
    // will be delivered)
    setTimeout(cb, 0)
  }

  /** Keeps only the latest pending reload; runs it on the next tick if no run is active */
  export function requestReloadWhenIdle(cb: () => void) {
    pendingReload = cb
    drainPendingReload()
  }

  export const Event = {
    Updated: BusEvent.define(
      "workflow.updated",
      z.object({
        sessionID: z.string(),
        runId: z.string(),
      }),
    ),
  }

  export async function read(sessionID: string, runId: string) {
    try {
      const cache = await Storage.read<WorkflowRunCache>(key(sessionID, runId))
      if (cache.version !== 1) return undefined
      return cache
    } catch (error) {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    }
  }

  export async function write(sessionID: string, cache: WorkflowRunCache) {
    await Storage.write(key(sessionID, cache.runId), cache)
  }

  export async function readRun(sessionID: string, runId: string) {
    try {
      return await Storage.read<WorkflowRunRecord>(recordKey(sessionID, runId))
    } catch (error) {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    }
  }

  export async function writeRun(sessionID: string, messageID: string, metadata: WorkflowRunMetadata) {
    const now = Date.now()
    const previous = await readRun(sessionID, metadata.runId)
    const record: WorkflowRunRecord = {
      ...metadata,
      sessionID,
      messageID,
      createdAt: metadata.createdAt ?? previous?.createdAt ?? now,
      updatedAt: metadata.updatedAt ?? now,
      ...(metadata.completedAt ? { completedAt: metadata.completedAt } : {}),
    }
    await Storage.write(recordKey(sessionID, metadata.runId), record)
    await Bus.publish(Event.Updated, {
      sessionID,
      runId: metadata.runId,
    })
    return record
  }

  export async function updateRun(sessionID: string, runId: string, fn: (draft: WorkflowRunRecord) => void) {
    try {
      const record = await Storage.update<WorkflowRunRecord>(recordKey(sessionID, runId), (draft) => {
        fn(draft)
        draft.updatedAt = Date.now()
      })
      await Bus.publish(Event.Updated, {
        sessionID,
        runId,
      })
      return record
    } catch (error) {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    }
  }

  export async function listRuns(sessionID: string) {
    // Mark stale runs aborted first. If the previous process was killed (SIGKILL, power loss), dispose never ran and
    // storage still says running; without this the UI would show a running workflow that no longer progresses.
    await reconcile(sessionID)
    const result: WorkflowRunRecord[] = []
    for (const item of await Storage.list(["workflow_run", sessionID])) {
      const run = await Storage.read<WorkflowRunRecord>(item).catch(() => undefined)
      if (!run) continue
      result.push(run)
    }
    return result.toSorted((a, b) => b.updatedAt - a.updatedAt)
  }

  /**
   * Marks the session's stale workflow runs aborted: runs not in a terminal status and not active in this process.
   * Runs active in this process are left alone. Idempotent.
   */
  async function reconcile(sessionID: string) {
    const live = active()[sessionID] ?? {}
    let scanned: Array<WorkflowRunRecord | undefined> = []
    try {
      scanned = await Storage.list(["workflow_run", sessionID]).then((items) =>
        Promise.all(items.map((item) => Storage.read<WorkflowRunRecord>(item).catch(() => undefined))),
      )
    } catch {
      return
    }
    for (const run of scanned) {
      if (!run) continue
      if (TERMINAL_STATUSES.has(run.status)) continue
      if (live[run.runId]) continue
      await updateRun(sessionID, run.runId, (draft) => {
        if (TERMINAL_STATUSES.has(draft.status)) return
        draft.status = "aborted"
        draft.completedAt = Date.now()
        draft.resumable = true
      }).catch(() => undefined)
    }
  }

  export function registerRun(sessionID: string, runId: string, control: AbortController | WorkflowRunControl) {
    const current = active()
    const runs = (current[sessionID] ??= {})
    const handle = control instanceof AbortController ? { abort: control } : control
    runs[runId] = handle

    return () => {
      if (runs[runId] !== handle) return
      delete runs[runId]
      if (Object.keys(runs).length === 0) delete current[sessionID]
      // The last run may have ended: run a deferred config reload
      drainPendingReload()
    }
  }

  export async function cancelRun(sessionID: string, runId: string) {
    const current = active()
    const runs = current[sessionID]
    const control = runs?.[runId]
    if (!control) return false

    // Abort first, then deliver the aborted notice here instead of relying on the runtime's async catch.
    // notifyCancelled is a closure on control, so deleting the entry does not affect it; the delete must come after
    // abort.
    control.abort.abort()
    delete runs[runId]
    if (Object.keys(runs).length === 0) delete current[sessionID]
    await control.notifyCancelled?.()
    // The last run may have ended: run a deferred config reload
    drainPendingReload()
    return true
  }
}
