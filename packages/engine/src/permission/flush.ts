import { Bus } from "../bus"
import { Config } from "../config/config"
import { Log } from "@merakcode/log/logger"
import { PermissionNext } from "./next"
import { Session } from "../session"
import { Message } from "../session/message"
import { Agent } from "../agent/agent"
import { SessionRunner } from "../session/runner"
import { PermissionPolicy } from "./policy"

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
    // A pending "sandbox is not ready" check was recorded before setup finished or the user turned the sandbox
    // off. Once commands are no longer blocked on that, the check is satisfied unless the current rules deny it.
    const { Sandbox } = await import("../sandbox")
    const settled = await Sandbox.ready()
    await PermissionNext.recheck(async (request, checks) => {
      const rules = await ruleset(request, checks)
      if (!rules || !settled) return rules
      const unsandboxed = checks.filter((check) => check.permission === "bash_unsandboxed")
      // A read-only session, or an explicit deny, still refuses the command. Only the default "ask because the
      // sandbox is not ready" is lifted.
      if (
        unsandboxed.length === 0 ||
        unsandboxed.some((check) => PermissionNext.evaluate(check.permission, check.pattern, rules).action === "deny")
      )
        return rules
      return [...rules, { permission: "bash_unsandboxed", pattern: "*", action: "allow" }]
    })
  }

  /**
   * Latest rule chain for the request's session: the calling agent (taken from the tool call's message) plus the
   * session tree's current permission mode
   */
  async function ruleset(
    request: PermissionNext.Request,
    checks: PermissionNext.Check[],
  ): Promise<PermissionNext.Ruleset | undefined> {
    const session = await Session.get(request.sessionID).catch(() => undefined)
    if (!session) return undefined
    if (request.executionID) {
      const root = await Session.rootID(session.id)
      const owner = root === session.id ? session : await Session.get(root)
      const config = await Config.get()
      const user = PermissionNext.merge(PermissionNext.fromUserConfig(config.permission ?? {}), owner.permission ?? [])
      const mode = await SessionRunner.modeOf(owner)
      const enforced = PermissionPolicy.ruleset(mode, user)
      if (checks.some((check) => PermissionNext.evaluate(check.permission, check.pattern, enforced).action === "deny"))
        return enforced
      return PermissionPolicy.ruleset(mode, PermissionNext.merge(user, await PermissionNext.grants(root)))
    }
    if (!request.tool?.messageID) return undefined
    const msg = await Message.get({ sessionID: request.sessionID, messageID: request.tool.messageID }).catch(
      () => undefined,
    )
    if (!msg || msg.info.role !== "assistant" || Message.isExternal(msg.info)) return undefined
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
