import { Agent } from "../agent"
import { Config } from "@merakcode/engine/agent/settings/index"
import { permissionLevelNow } from "../permission/permission-level"
import { PermissionLevel } from "../permission/level"

/** Shared selection rules; Session remains the only persisted permission-mode authority. */
export namespace PromptMode {
  export interface Input {
    sessionID?: string
    agent?: string
  }
  export async function resolve(input: Input) {
    const config = await Config.get()
    return {
      agentID: input.agent ?? config.default_agent ?? (await Agent.defaultAgent()),
      permissionLevel: input.sessionID ? permissionLevelNow(input.sessionID) : PermissionLevel.DEFAULT,
    }
  }
}
