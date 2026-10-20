/**
 * Decides which plan mode system reminder to inject (pure function). Plan mode is the readonly mode.
 * Used by runner.insertReminders; keeping the decision free of I/O lets tests pin the behavior.
 */
import type { PermissionMode } from "../permission/mode"

export type PlanReminderKind =
  /** Just entered readonly mode: inject the full Phase 1–5 workflow */
  | "enter"
  /** Just left readonly mode and a plan file exists: inject BUILD_SWITCH */
  | "build-switch"
  /** Still in readonly mode and a plan file exists: urge plan_exit instead of editing project files */
  | "stay-call-exit"
  | "none"

/**
 * Decides which plan reminder to inject into this turn's user message.
 * mode is this step's permission mode; lastMode is the mode of the previous reply (undefined before any reply).
 * Subagents follow the main session's mode but never enter the plan flow.
 */
export function resolvePlanReminderKind(input: {
  planModeEnabled: boolean
  mode: PermissionMode.Value
  lastMode?: PermissionMode.Value
  planExists: boolean
  child: boolean
}): PlanReminderKind {
  if (!input.planModeEnabled || input.child) return "none"
  const planning = input.mode === "readonly"
  const wasPlanning = input.lastMode === "readonly"
  if (!planning && wasPlanning) return input.planExists ? "build-switch" : "none"
  if (planning && !wasPlanning) return "enter"
  if (planning && input.planExists) return "stay-call-exit"
  return "none"
}

/** Reminder for later plan mode turns once the plan exists: implementing requires plan_exit, not direct file edits */
export function planStayCallExitReminder(planPath: string): string {
  return `<system-reminder>
Plan mode is still active. A plan file already exists at ${planPath}.

If the user wants to implement or execute the plan now — including phrases like
「开始执行」「开始实施」「执行方案」「实现方案」「切换到 build」,
"execute the plan", "start implementing", or "switch to build" —
you MUST call the plan_exit tool in this turn and wait for approval.
Do NOT edit project files, run non-readonly tools, or start implementing while still in plan mode.

If the user wants to refine the plan, stay in plan mode and edit only the plan file above.
</system-reminder>`
}
