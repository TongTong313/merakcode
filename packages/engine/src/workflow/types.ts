import z from "zod"
import type { PermissionMode } from "../permission/mode"

// Run records are sent to clients (workflow.list / workflow.get), so they are schemas to give the SDK types
export const WorkflowPhaseMeta = z.object({
  title: z.string(),
  detail: z.string().optional(),
  model: z.string().optional(),
})
export type WorkflowPhaseMeta = z.infer<typeof WorkflowPhaseMeta>

export type WorkflowMeta = {
  name: string
  description: string
  whenToUse?: string
  concurrency?: number
  maxConcurrentAgents?: number
  phases: WorkflowPhaseMeta[]
}

export type WorkflowScript = WorkflowMeta & {
  script: string
  body: string
  scriptPath?: string
  source: "builtin" | "project" | "global" | "custom"
}

export const WorkflowAgentStatus = z.enum(["queued", "running", "completed", "failed", "cached"])
export type WorkflowAgentStatus = z.infer<typeof WorkflowAgentStatus>

export const WorkflowAgentToolProgress = z.object({
  tool: z.string(),
  callID: z.string(),
  status: z.enum(["pending", "running", "completed", "error"]),
  title: z.string().optional(),
  summary: z.string().optional(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  updatedAt: z.number(),
})
export type WorkflowAgentToolProgress = z.infer<typeof WorkflowAgentToolProgress>

export const WorkflowAgentProgress = z.object({
  id: z.string(),
  label: z.string(),
  phase: z.string().optional(),
  agent: z.string(),
  model: z.object({ providerID: z.string(), modelID: z.string() }).optional(),
  sessionId: z.string().optional(),
  status: WorkflowAgentStatus,
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  error: z.string().optional(),
  toolCount: z.number().optional(),
  latestTool: WorkflowAgentToolProgress.optional(),
})
export type WorkflowAgentProgress = z.infer<typeof WorkflowAgentProgress>

export const WorkflowLogProgress = z.object({
  id: z.string(),
  level: z.enum(["log", "narrate"]),
  message: z.string(),
  phase: z.string().optional(),
  at: z.number(),
})
export type WorkflowLogProgress = z.infer<typeof WorkflowLogProgress>

export const WorkflowWorkUnit = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  phase: z.string().optional(),
  files: z.array(z.string()).optional(),
  agentId: z.string().optional(),
  agentLabel: z.string().optional(),
  agentType: z.string().optional(),
  status: WorkflowAgentStatus,
})
export type WorkflowWorkUnit = z.infer<typeof WorkflowWorkUnit>

export const WorkflowRunStatus = z.enum(["running", "completed", "failed", "aborted"])
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatus>

export const WorkflowRunMetadata = z.object({
  status: WorkflowRunStatus,
  workflowName: z.string(),
  description: z.string().optional(),
  runId: z.string(),
  messageID: z.string().optional(),
  scriptPath: z.string().optional(),
  phase: z.string().optional(),
  phases: z.array(WorkflowPhaseMeta),
  agents: z.array(WorkflowAgentProgress),
  workUnits: z.array(WorkflowWorkUnit).optional(),
  logs: z.array(WorkflowLogProgress),
  result: z.unknown().optional(),
  error: z.string().optional(),
  resumable: z.boolean(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  completedAt: z.number().optional(),
  maxConcurrentAgents: z.number().optional(),
  maxTotalAgents: z.number().optional(),
  agentCount: z.number().optional(),
  queuedAgentCount: z.number().optional(),
  runningAgentCount: z.number().optional(),
  completedAgentCount: z.number().optional(),
  failedAgentCount: z.number().optional(),
  cachedAgentCount: z.number().optional(),
})
export type WorkflowRunMetadata = z.infer<typeof WorkflowRunMetadata>

export const WorkflowRunRecord = WorkflowRunMetadata.extend({
  sessionID: z.string(),
  messageID: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
}).meta({ ref: "WorkflowRun" })
export type WorkflowRunRecord = z.infer<typeof WorkflowRunRecord>
export type WorkflowRunControl = {
  abort: AbortController
  /**
   * Delivers the aborted notice right away when the user cancels.
   *
   * The runtime's async catch is too slow (the abort has to reach child sessions, they cancel, the prompt throws):
   * the notice could be enqueued after the next foreground turn and be mistaken for a new workflow's status.
   * Implemented by the tool layer: persists the run as aborted, then enqueues and delivers the notice. The
   * notification id is stable (workflow_finished_<sessionID>_<runId>) and enqueue is idempotent, so the catch
   * delivering again does not duplicate it.
   */
  notifyCancelled?(): Promise<void> | void
}

export type WorkflowAgentOptions = {
  label?: string
  phase?: string
  agent?: string
  agentType?: string
  model?: string
  /** @deprecated Currently ignored by the workflow runtime. */
  maxTurns?: number
  /** Allowlist that narrows visible tools for this workflow child turn. */
  allowedTools?: string[]
  /** Alias for allowedTools. */
  tools?: string[]
  schema?: Record<string, unknown>
  /** @deprecated Workflow child permissions inherit from the caller; this option is ignored. */
  kind?: PermissionMode.Value
  /** @deprecated Currently ignored by the workflow runtime. */
  isolation?: "worktree"
  workUnitId?: string
}

export type WorkflowRunCacheEntry = {
  hash: string
  result: unknown
  agent: WorkflowAgentProgress
}

export type WorkflowRunCache = {
  version: 1
  runId: string
  workflowName: string
  scriptPath?: string
  entries: WorkflowRunCacheEntry[]
}
