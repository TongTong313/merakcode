import { discoverProject } from "@merakcode/engine/app/project/discover"
import { ulid } from "ulid"
import { Instance } from "../../../infra/project/instance"
import { Storage } from "../../../infra/storage/storage"
import { Log } from "@merakcode/log/logger"
import { Loop } from "../../../agent/loop/index"
import type { PermissionMode } from "../../../agent/permission/mode"
import type { Workspace } from "../../../infra/project/workspace"

/**
 * CronScheduler: scheduled /loop tasks.
 *
 * Lifecycle (like Claude Code: bound to the session and restored from disk, not a global background daemon):
 * - Timers live in the engine process.
 * - Task definitions are persisted (per-project Instance Storage). After a crash, restart or app close, recover()
 *   re-arms them the next time the project opens; missed runs are not caught up.
 * - Deleting the session removes them for good via removeBySession(). Between runs the session stays idle in the UI.
 */
export namespace CronScheduler {
  const log = Log.create({ service: "scheduler.loop" })

  export interface CronTask {
    id: string
    /** Session that receives the prompt on each run */
    sessionID: string
    /** Root session; deleting it also removes tasks created in its child sessions */
    rootID: string
    /** Session directory at creation, used to rebuild the Instance context on each run */
    directory: string
    /** Multi-root workspace folders (omitted for a single root) */
    workspaceFolders?: Array<{ path: string; name?: string }>
    interval: number
    prompt: string
    agent?: string
    permissionMode?: PermissionMode.Value
    model?: {
      providerID: string
      modelID: string
    }
    createdAt: number
    lastRun?: number
    nextRun: number
    status: "running" | "paused"
    lastStatus?: "success" | "error"
    lastResult?: string
  }

  /**
   * Runtime state: tasks and timers.
   *
   * Attached to the session's Instance via Instance.state, so timers are cleared when the Instance is disposed.
   * This only holds tasks running in this process; Storage is the authoritative, recoverable copy.
   */
  const state = Instance.state(
    () => ({
      tasks: new Map<string, CronTask>(),
      timers: new Map<string, ReturnType<typeof setInterval>>(),
    }),
    async (entry) => {
      for (const timer of entry.timers.values()) clearInterval(timer)
      entry.timers.clear()
      entry.tasks.clear()
    },
  )

  /** Storage key ["cron", rootID, taskId], grouped by root session so deleting the root removes them all */
  function taskKey(task: Pick<CronTask, "rootID" | "id">) {
    return ["cron", task.rootID, task.id]
  }

  /**
   * Pending writes per task. Storage.remove / removePrefix do not take the write lock: a delete racing an in-flight
   * write gets the file written back afterwards, leaving an orphan task that the next recover() re-arms.
   * Running once on creation makes this common: when a task is deleted right away, its first result is often still
   * being written. Deleters first drop the task from memory (so patch starts no new writes), wait for the write
   * recorded here, then delete from disk.
   */
  const pendingWrites = new Map<string, Promise<void>>()

  async function persist(task: CronTask) {
    const write = Storage.write(taskKey(task), task).catch((error) => {
      log.error("task persist failed", { id: task.id, error: error instanceof Error ? error.message : String(error) })
    })
    pendingWrites.set(task.id, write)
    await write
    // Writes of one task queue on the Storage lock, so only the latest is tracked; drop it once done unless replaced
    if (pendingWrites.get(task.id) === write) pendingWrites.delete(task.id)
  }

  async function unpersist(task: Pick<CronTask, "rootID" | "id">) {
    await Storage.remove(taskKey(task)).catch(() => {})
  }

  /** Arms the timer without running now, so recovery does not catch up missed runs */
  function arm(task: CronTask) {
    const { timers } = state()
    const prev = timers.get(task.id)
    if (prev) clearInterval(prev)
    const timer = setInterval(() => void tick(task.id), task.interval)
    timer.unref() // the timer must not keep the process alive
    timers.set(task.id, timer)
  }

  function disarm(id: string) {
    const { timers } = state()
    const timer = timers.get(id)
    if (timer) clearInterval(timer)
    timers.delete(id)
  }

  /**
   * Timer callback: rebuilds the task's Instance context and runs the prompt only if the session is idle.
   * Timers inherit the request scope of their creation; background runs must leave it so they never reuse a finished
   * or cancelled request.
   */
  async function tick(id: string) {
    const task = state().tasks.get(id)
    if (!task || task.status !== "running") return

    await Instance.provide({
      resolveProject: discoverProject,
      directory: task.directory,
      workspace: task.workspaceFolders ? { folders: task.workspaceFolders } : undefined,
      fn: () => execute(task),
    }).catch((error) => {
      log.error("task tick failed", { taskID: id, error: error instanceof Error ? error.message : String(error) })
    })
  }

  /** Runs the task in the background and records the outcome in memory and Storage */
  async function execute(task: CronTask) {
    log.info("task executing", { taskID: task.id, sessionID: task.sessionID })
    try {
      const ran = await Loop.background({
        sessionID: task.sessionID,
        parts: [{ type: "text", text: task.prompt }],
        noReply: false,
        ...(task.agent ? { agent: task.agent } : {}),
        // Restore the permission mode from creation, so a task created in auto mode does not fall back to asking
        ...(task.permissionMode ? { permissionMode: task.permissionMode } : {}),
        ...(task.model ? { model: task.model } : {}),
      })
      if (!ran) {
        log.info("session busy, task skipped", { taskID: task.id, sessionID: task.sessionID })
        return
      }
      await patch(task.id, { lastRun: Date.now(), nextRun: Date.now() + task.interval, lastStatus: "success" })
      log.info("task completed", { taskID: task.id, sessionID: task.sessionID })
    } catch (error) {
      await patch(task.id, { lastStatus: "error", lastResult: error instanceof Error ? error.message : String(error) })
      log.error("task execution failed", { taskID: task.id, sessionID: task.sessionID, error })
    }
  }

  /** Updates task fields in memory and Storage, only while the task is still live in this process */
  async function patch(id: string, changes: Partial<CronTask>) {
    const task = state().tasks.get(id)
    if (!task) return
    Object.assign(task, changes)
    await persist(task)
  }

  export async function create(params: {
    interval: number
    prompt: string
    sessionID: string
    agent?: string
    permissionMode?: PermissionMode.Value
    model?: {
      providerID: string
      modelID: string
    }
  }): Promise<string> {
    const id = ulid()
    const task: CronTask = {
      id,
      sessionID: params.sessionID,
      rootID: await resolveRootID(params.sessionID),
      directory: Instance.directory,
      workspaceFolders: currentWorkspaceFolders(),
      interval: params.interval,
      prompt: params.prompt,
      agent: params.agent,
      permissionMode: params.permissionMode,
      model: params.model,
      createdAt: Date.now(),
      nextRun: Date.now() + params.interval,
      status: "running",
    }

    state().tasks.set(id, task)
    await persist(task)
    arm(task)
    // A new task runs once right away, then every interval; otherwise /loop would wait a full interval before its
    // first run. arm() not running immediately only matters for recovery. tick catches its own errors and skips busy
    // sessions, so it is not awaited.
    void tick(id)

    log.info("task created", {
      id,
      interval: params.interval,
      agent: params.agent,
      permissionMode: params.permissionMode,
      providerID: params.model?.providerID,
      modelID: params.model?.modelID,
    })
    return id
  }

  export function list(sessionID?: string): CronTask[] {
    const tasks = [...state().tasks.values()]
    return sessionID ? tasks.filter((t) => t.sessionID === sessionID) : tasks
  }

  export async function remove(id: string): Promise<boolean> {
    const task = state().tasks.get(id)
    if (!task) return false
    disarm(id)
    state().tasks.delete(id)
    await pendingWrites.get(id)
    await unpersist(task)
    log.info("task removed", { id })
    return true
  }

  /**
   * Removes every task of a deleted session tree, both timers and Storage.
   *
   * Timers are only cleared in the engine process that holds them; Storage is cleared by root session prefix so no
   * orphan files remain.
   */
  export async function removeBySession(sessionID: string): Promise<void> {
    const { tasks } = state()
    const owned = [...tasks.values()].filter((t) => t.sessionID === sessionID || t.rootID === sessionID)
    for (const task of owned) {
      disarm(task.id)
      tasks.delete(task.id)
    }
    // Wait for in-flight writes first, or they would write the tasks back (see pendingWrites)
    await Promise.all(owned.map((task) => pendingWrites.get(task.id)))
    // sessionID is the deleted root session
    await Storage.removePrefix(["cron", sessionID]).catch(() => {})
    if (owned.length) log.info("tasks removed by session", { sessionID, count: owned.length })
  }

  /**
   * Restores running tasks of this Instance (project) from Storage and re-arms their timers without catching up.
   * Called by InstanceBootstrap.
   */
  export async function recover(): Promise<void> {
    const keys = await Storage.list(["cron"]).catch(() => [] as string[][])
    let recovered = 0
    for (const key of keys) {
      const task = await Storage.read<CronTask>(key).catch(() => undefined)
      if (!task || task.status !== "running") continue
      // Tasks keep their creation context; skip tasks of another directory so they are not restored into this project
      if (task.directory !== Instance.directory) continue
      state().tasks.set(task.id, task)
      arm(task)
      recovered++
    }
    if (recovered) log.info("tasks recovered", { count: recovered })
  }

  /**
   * Resolves the root session, falling back to the session itself.
   * Session.rootID may throw synchronously on an invalid id, so .catch() alone is not enough.
   */
  async function resolveRootID(sessionID: string): Promise<string> {
    try {
      const { Session } = await import("../../../agent/session")
      return await Session.rootID(sessionID)
    } catch {
      return sessionID
    }
  }

  /** Current multi-root workspace folders; undefined for a single root, matching Instance.provide's input */
  function currentWorkspaceFolders(): Array<{ path: string; name?: string }> | undefined {
    if (!Instance.has()) return undefined
    const folders: Workspace.Info["folders"] = Instance.workspace.folders
    if (folders.length <= 1) return undefined
    return folders.map((f) => ({ path: f.path, name: f.name }))
  }
}
