import { ToolRegistry } from "../../agent/tools/registry"
import { DelegateTool } from "./tools/delegate"
import { WorkflowRunTool } from "./tools/workflow"
import { CronCreateTool, CronListTool, CronDeleteTool } from "./tools/cron"
import { Command } from "../../agent/prompt/command"
import { SessionContextView } from "../../agent/context/context-view"
import { Loop } from "../../agent/loop"
import { WorkflowState } from "./workflow/state"
import { leaderContext } from "./collaboration/context"
import { workflowCommands } from "./commands"

export function installTaskCapabilities() {
  ToolRegistry.installBuiltins([DelegateTool, WorkflowRunTool, CronCreateTool, CronListTool, CronDeleteTool])
  Command.useCommands(workflowCommands)
  SessionContextView.useGroupContext(leaderContext)
  Loop.useWorkflows({ list: WorkflowState.listRuns, cancel: WorkflowState.cancelRun })
}
