// Pure orchestration for force-stopping a whole session tree. All dependencies are injected, so it has no Storage or
// Instance side effects. Undo calls it before touching files: the foreground session, background workflows,
// background bash jobs and all child sessions are stopped first, so assertNotBusy passes and no background task keeps
// editing files after the rollback.

/** Workflow run states that count as active and must be stopped */
const WORKFLOW_ACTIVE = new Set(["running", "paused"])

/** Default timeout (ms) for waiting on a loop to stop, so a stuck loop cannot hang undo forever */
export const LOOP_STOP_TIMEOUT_MS = 3_000

/**
 * Waits for the "loop has stopped" promise with a best-effort timeout:
 * - done is undefined (the session was not running): returns immediately;
 * - otherwise races done against the timeout and continues even if the loop has not stopped, since undo must never
 *   hang.
 * sleep is injectable so tests can trigger or suppress the timeout deterministically.
 */
export function awaitLoopStopped(
  done: Promise<void> | void,
  timeoutMs: number = LOOP_STOP_TIMEOUT_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  if (!done) return Promise.resolve()
  return Promise.race([done, sleep(timeoutMs)])
}

/** Injected dependencies of cancelSessionTree; see the cancelTree wiring in runner.ts for the real primitives */
export type CancelTreeDeps = {
  /**
   * Stops one session (synchronous abort, removes its running state, cascades to blocking subagents).
   * Returns a promise that resolves once the session loop has stopped (with a timeout), so the caller can wait before
   * touching files; returns void when the session was not running.
   */
  cancelSelf: (sessionID: string) => Promise<void> | void
  /** Lists all workflow runs of a session, including finished ones; filtering by state happens here */
  listWorkflowRuns: (sessionID: string) => Promise<Array<{ runId: string; status: string }>>
  cancelWorkflowRun: (sessionID: string, runId: string) => Promise<unknown>
  /** Lists background bash jobs of all sessions; filtered here by sessionID and running state */
  listBashJobs: () => Array<{ id: string; sessionID?: string; status: string }>
  stopBashJob: (id: string) => Promise<unknown>
  /** Lists direct child sessions */
  listChildren: (sessionID: string) => Promise<Array<{ id: string }>>
}

/**
 * Force-stops a session tree: the session, its active workflow runs, its running background bash jobs, then all child
 * sessions recursively. Idempotent. A failure to stop one background task does not block the rest (best-effort),
 * because the rollback takes priority.
 */
export async function cancelSessionTree(sessionID: string, deps: CancelTreeDeps): Promise<void> {
  // Abort synchronously so assertNotBusy(sessionID) passes at once. Keep the "loop stopped" promise and await it
  // before recursing: undo must not race a loop that is still exiting (e.g. the processor writing in-flight
  // PatchParts).
  const stopped = deps.cancelSelf(sessionID)

  // Detached workflows are not stopped by cancelSelf and must be cancelled explicitly. Do it before awaiting stopped,
  // otherwise the owner loop may be waiting on these background tasks and both sides wait forever.
  for (const run of await deps.listWorkflowRuns(sessionID)) {
    if (WORKFLOW_ACTIVE.has(run.status)) {
      await deps.cancelWorkflowRun(sessionID, run.runId).catch(() => undefined)
    }
  }

  // Match by exact sessionID so jobs of other sessions are never stopped.
  for (const job of deps.listBashJobs()) {
    if (job.sessionID === sessionID && job.status === "running") {
      await deps.stopBashJob(job.id).catch(() => undefined)
    }
  }

  // The timeout lives in awaitLoopStopped on the runner side; stopped is void when the session was not running.
  if (stopped) await stopped

  // Child sessions (workflow stage sessions, nested subagents) each wait for their own loop.
  for (const child of await deps.listChildren(sessionID)) {
    await cancelSessionTree(child.id, deps)
  }
}
