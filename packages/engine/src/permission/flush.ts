import { Bus } from "../bus"
import { Config } from "../config/config"
import { Log } from "@merakcode/log/logger"
import { PermissionNext } from "./next"
import { Session } from "../session"
import { Message } from "../session/message"
import { Agent } from "../agent/agent"
import { SessionRunner } from "../session/runner"

const log = Log.create({ service: "permission.flush" })

/**
 * Re-evaluates pending requests after the rules change: a config update (Config.UpdatedEvent) or a permission mode
 * switch (Session.setPermissionMode).
 *
 * Typical case: several parallel tool calls wait for approval, then the user allows one kind in config or switches
 * to auto mode; requests whose checks are all allowed now are released, the rest stay.
 */
export namespace PermissionFlush {
  export function init(): void {
    // Disposing an Instance clears the Bus subscriptions for its directory, so register on every bootstrap. Do not
    // dedupe per process, or reopening the same path after dispose would miss the subscription.
    Bus.subscribe(Config.UpdatedEvent, () => {
      // Use a macrotask: the config writer calls Agent.invalidate() synchronously only after awaiting the disk write.
      // A microtask could race with invalidate and still read the old Agent.
      setTimeout(() => {
        void run().catch((err) => log.warn("permission.flush run failed", { err }))
      }, 0)
    })
  }

  export async function run(): Promise<void> {
    await PermissionNext.recheck(ruleset)
  }

  /**
   * Latest rule chain for the request's session: the calling agent (taken from the tool call's message) plus the
   * session tree's current permission mode
   */
  async function ruleset(request: PermissionNext.Request): Promise<PermissionNext.Ruleset | undefined> {
    if (!request.tool?.messageID) return undefined
    const session = await Session.get(request.sessionID).catch(() => undefined)
    if (!session) return undefined
    const msg = await Message.get({ sessionID: request.sessionID, messageID: request.tool.messageID }).catch(
      () => undefined,
    )
    if (!msg || msg.info.role !== "assistant") return undefined
    const agent = await Agent.get(msg.info.agent).catch(() => undefined)
    if (!agent) return undefined
    return SessionRunner.buildToolExecutionRuleset({
      agent,
      session,
      permissionMode: await SessionRunner.modeOf(session),
      grants: await SessionRunner.grantsOf(session),
    })
  }
}
