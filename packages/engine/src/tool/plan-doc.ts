import path from "path"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { Filesystem } from "@merakcode/util/filesystem"
import type { PermissionMode } from "../permission/mode"

/**
 * Decides whether a path is a plan file the agent may write silently, without approval.
 *
 * On a bypass, callers must also skip these side effects (plan files live outside the worktree and mean nothing to
 * the project):
 *   1. the ctx.ask permission prompt
 *   2. Snapshot.trackFile (plans are not on the project's undo/revert stack)
 *   3. Bus.publish(File.Event.Edited)
 *   4. Bus.publish(FileWatcher.Event.Updated)
 *   5. LSP.diagnosticsAfterEdit (or the equivalent touchFile / diagnostics)
 *
 * Still required: FileTime.withLock / assert / read (the session's read-before-write record).
 *
 * Only plan mode (main session in read-only mode) may write plans: any *.md under Global.Path.data/plans.
 *
 * The Session module is imported dynamically to avoid the static cycle plan-doc → session → runner →
 * tool/registry → tool/edit → plan-doc. Session is always loaded by the time this runs, so the import hits the cache.
 */
export type PlanDocAuthor = { agent: string; permissionMode?: PermissionMode.Value; sessionID?: string }

/** Whether the path is a .md file under the plans data directory; plansDir can be injected for tests */
export function isUnderPlansDataDir(absPath: string, plansDir = path.join(Global.Path.data, "plans")): boolean {
  const normalized = path.normalize(absPath)
  if (!normalized.endsWith(".md")) return false
  // Filesystem.contains handles Windows drive letter case (c: vs C:), which startsWith gets wrong
  return Filesystem.contains(plansDir, normalized)
}

/** Plan mode means the main session is in read-only mode; subagents follow that mode but do not write plans */
async function planning(author: PlanDocAuthor) {
  if (!Flag.MERAKCODE_PLAN_MODE || author.permissionMode !== "readonly") return false
  if (!author.sessionID) return true
  const { Session } = await import("../session")
  // Session.get throws synchronously on an invalid id; wrapping it routes that into the catch
  const session = await Promise.resolve(author.sessionID)
    .then((id) => Session.get(id))
    .catch(() => undefined)
  return !session?.parentID
}

export async function isPlanDocBypass(author: PlanDocAuthor, absPath: string): Promise<boolean> {
  const normalized = path.normalize(absPath)
  if (!normalized.endsWith(".md")) return false

  return isUnderPlansDataDir(normalized) && (await planning(author))
}

/**
 * Forbids writing plan files outside plan mode. Plans must stay protected after the user declines plan_enter; the
 * error tells the model to call plan_enter first.
 */
export async function assertCanWritePlanDoc(author: PlanDocAuthor, absPath: string): Promise<void> {
  if (!isUnderPlansDataDir(absPath)) return
  if (await isPlanDocBypass(author, absPath)) return
  throw new Error(
    "Cannot modify plan files outside plan mode. Call plan_enter and get user approval before editing the plan.",
  )
}

/**
 * Forbids writing project files in plan mode; implementing needs the user's approval through plan_exit first. Plan
 * files are still allowed (isPlanDocBypass lets them through). This fails earlier and more clearly than the
 * permission layer's DeniedError, before the model has generated long content in plan mode.
 */
export async function assertPlanModeAllowsWrite(author: PlanDocAuthor, absPath: string): Promise<void> {
  if (!(await planning(author))) return
  if (await isPlanDocBypass(author, absPath)) return
  throw new Error(
    "Cannot edit project files while in plan mode. Call plan_exit and get user approval before implementing.",
  )
}
