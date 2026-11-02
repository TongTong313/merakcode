import { Agent } from "../agent"
import { Config } from "@merakcode/engine/agent/settings/index"
import { sessionModeNow } from "../permission/session-mode"
import { SessionMode } from "../permission/mode"

/** Shared selection rules; Session remains the only persisted permission-mode authority. */
export namespace PromptMode {
  export interface Input {
    sessionID?: string
    agent?: string
    sessionMode?: SessionMode.Value
    kind?: SessionMode.Value
    permissionMode?: "readonly" | "ask"
  }
  export async function resolve(input: Input) {
    const config = await Config.get()
    return {
      agentID: input.agent ?? config.default_agent ?? (await Agent.defaultAgent()),
      sessionMode:
        input.sessionMode ??
        input.kind ??
        (input.permissionMode === "readonly"
          ? "plan"
          : input.permissionMode === "ask"
            ? "execute"
            : input.sessionID
              ? sessionModeNow(input.sessionID)
              : SessionMode.DEFAULT),
    }
  }
}
