import { Agent } from "../agent/agent"
import { Config } from "../config/config"
import { PermissionMode } from "../permission/mode"

/** Shared selection rules; Session remains the only persisted permission-mode authority. */
export namespace PromptMode {
  export interface Input {
    agent?: string
    permissionMode?: PermissionMode.Value
    kind?: PermissionMode.Value
  }
  export async function resolve(input: Input) {
    const config = await Config.get()
    return {
      agentID: input.agent ?? config.default_agent ?? (await Agent.defaultAgent()),
      permissionMode: input.permissionMode ?? input.kind ?? PermissionMode.DEFAULT,
    }
  }
}
