import { Instance } from "../../infra/project/instance"
import { Text } from "../prompt/text"
import { Message } from "../session/message"
import { Session } from "../session"

/**
 * After an engine crash or hard kill, unfinished native tool parts stay `pending`/`running` on disk because
 * `Loop.cancel` never ran. Workflow runs and external turns already reconcile on resume; this covers the
 * remaining native tools so the UI stops spinning and a later prompt does not resume a zombie turn.
 *
 * Triggered from `Session.get` (idle zombies after restart) and from `Loop` dispose (live sessions cut off
 * by a graceful shutdown that did not finish cancel reconciliation).
 */
export namespace SessionCrash {
  const recovered = Instance.state(() => new Set<string>())

  /** Load path: settle once per session while no live loop owns it. */
  export async function reconcile(sessionID: string, isLive: () => boolean) {
    if (recovered().has(sessionID)) return
    if (isLive()) return
    recovered().add(sessionID)
    try {
      await settle(sessionID)
    } catch (error) {
      recovered().delete(sessionID)
      throw error
    }
  }

  /** Dispose path: always write unfinished parts for a session whose loop is being torn down. */
  export async function settleDisposed(sessionID: string) {
    try {
      await settle(sessionID)
    } catch {
      // Best-effort on dispose
    }
  }

  async function settle(sessionID: string) {
    const toolError = await Text.pick({
      zh: "引擎在完成本轮工具调用前重启，任务已中断",
      en: "The engine restarted before this tool call finished",
    })
    const turnError = await Text.pick({
      zh: "引擎在完成本轮回复前重启，任务已中断",
      en: "The engine restarted before this turn finished",
    })
    const now = Date.now()
    for await (const message of Message.stream(sessionID)) {
      if (Message.isExternal(message.info) || message.info.role !== "assistant") continue
      let touched = false
      for (const part of message.parts) {
        if (part.type !== "tool") continue
        if (part.state.status === "completed" || part.state.status === "error") continue
        // Detached workflow_run is reconciled through WorkflowState / PartSync, not here.
        if (part.tool === "workflow_run") continue
        const time =
          part.state.status === "running" && "time" in part.state
            ? { start: part.state.time.start, end: now }
            : { start: now, end: now }
        await Session.updatePart({
          ...part,
          state: {
            ...part.state,
            status: "error" as const,
            error: toolError,
            time,
          } as Message.ToolStateError,
        })
        touched = true
      }
      // An unfinished assistant (tool-calls / unknown / no finish, and no abort error) would otherwise stay
      // "unanswered" and the next prompt would resume that turn instead of the user's new message.
      const unfinished =
        !message.info.error &&
        (!message.info.finish || message.info.finish === "tool-calls" || message.info.finish === "unknown")
      if (touched || unfinished) {
        await Session.updateInfo({
          ...message.info,
          time: { ...message.info.time, completed: now },
          error: new Message.AbortedError({ message: turnError }).toObject(),
        })
      }
    }
  }
}
