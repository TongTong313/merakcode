import { Bus } from "../../../infra/bus"
import { Log } from "@merakcode/log/logger"
import { Session } from "../../../agent/session"
import { Message } from "../../../agent/session/message"
import { WorkflowState } from "./state"
import type { WorkflowRunMetadata, WorkflowRunRecord } from "./types"

/**
 * WorkflowPartSync: copies the terminal state of a persisted workflow record into the completed workflow_run tool
 * part of the conversation (part.state.metadata), so the part ends up matching the record whether or not a
 * processor is still alive.
 *
 * workflow_run is fire-and-forget: the part is completed as soon as execute returns, and its state.metadata is only
 * updated through the in-process ctx.metadata, which needs a live processor. When a run ends without one (reconcile
 * after resume, dispose on shutdown, records already terminal), the part keeps the running snapshot from launch and
 * the card shows "running" forever while the record, list and overview say aborted.
 *
 * Two triggers share syncRunToPart; both are idempotent:
 * - init(): subscribes to WorkflowState.Event.Updated and syncs as soon as a run is terminal (cancel, runtime catch,
 *   dispose and reconcile all publish it).
 * - syncRuns(): called by the workflow.list route after listRuns to catch terminal runs whose part is still stuck,
 *   covering records reconcile skips and the crash window.
 */
export namespace WorkflowPartSync {
  const log = Log.create({ service: "workflow-part-sync" })
  const TERMINAL_STATUSES = new Set<WorkflowRunMetadata["status"]>(["completed", "failed", "aborted"])

  function isTerminal(status: WorkflowRunMetadata["status"] | undefined) {
    return status !== undefined && TERMINAL_STATUSES.has(status)
  }

  /**
   * Copies a terminal workflow record into its completed workflow_run tool part.
   *
   * - A record that is not terminal is ignored; live progress still comes from the in-process ctx.metadata.
   * - A part that is already terminal is skipped, so a richer in-process snapshot is not overwritten.
   * - Without a messageID or a matching part it returns silently.
   * - All errors are swallowed: this runs inside writeRun's Bus.publish chain, and an uncaught error would reject
   *   writeRun and hooks.update, breaking live workflow progress.
   */
  export async function syncRunToPart(record: WorkflowRunRecord | undefined) {
    try {
      if (!record?.messageID) return
      if (!isTerminal(record.status)) return
      const parts = await Message.parts({ sessionID: record.sessionID, messageID: record.messageID })
      const part = parts.find(
        (p): p is Message.ToolPart =>
          p.type === "tool" &&
          p.tool === "workflow_run" &&
          p.state.status === "completed" &&
          (p.state as { metadata?: { runId?: string } }).metadata?.runId === record.runId,
      )
      if (!part || part.state.status !== "completed") return
      const current = part.state.metadata as { status?: WorkflowRunMetadata["status"] } | undefined
      if (isTerminal(current?.status)) return
      await Session.updatePart({
        ...part,
        state: { ...part.state, metadata: record },
      })
    } catch (error) {
      log.warn("syncRunToPart failed", { runId: record?.runId, error: String(error) })
    }
  }

  /** Syncs each record (usually from listRuns); called by the workflow.list route */
  export async function syncRuns(records: WorkflowRunRecord[]) {
    for (const record of records) await syncRunToPart(record)
  }

  /**
   * Subscribes to WorkflowState.Event.Updated and syncs the part as soon as a run is terminal.
   * The subscription is per Instance, registered by InstanceBootstrap.
   */
  export function init() {
    Bus.subscribe(WorkflowState.Event.Updated, async (event) => {
      const record = await WorkflowState.readRun(event.properties.sessionID, event.properties.runId).catch(
        () => undefined,
      )
      await syncRunToPart(record)
    })
  }
}
