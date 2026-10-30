import { WorkflowRegistry } from "./workflow/registry"
import type { Command } from "../../agent/prompt/command"

export async function workflowCommands(): Promise<Command.Info[]> {
  const result: Record<string, Command.Info> = {}
  for (const workflow of await WorkflowRegistry.list()) {
    if (result[workflow.name]) continue
    result[workflow.name] = {
      name: workflow.name,
      description: workflow.description,
      source: "command",
      get template() {
        return [
          `Call workflow_run with name ${JSON.stringify(workflow.name)}.`,
          "Pass the user arguments as args.",
          "Use the current agent and call workflow_run as a tool; do not switch agents or expand the workflow manually.",
          "",
          "User arguments:",
          "$ARGUMENTS",
        ].join("\n")
      },
      hints: ["$ARGUMENTS"],
    }
  }

  return Object.values(result)
}
