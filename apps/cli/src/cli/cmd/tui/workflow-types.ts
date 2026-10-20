/** Workflow run record types, derived from the SDK-generated WorkflowRun. */
import type { WorkflowRun } from "@merakcode/sdk/client"

export type WorkflowRunRecord = WorkflowRun
export type WorkflowAgentProgress = WorkflowRun["agents"][number]
export type WorkflowAgentToolProgress = NonNullable<WorkflowAgentProgress["latestTool"]>
export type WorkflowPhaseMeta = WorkflowRun["phases"][number]
export type WorkflowWorkUnit = NonNullable<WorkflowRun["workUnits"]>[number]
