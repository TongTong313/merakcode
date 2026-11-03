import z from "zod"
import { NamedError } from "@merakcode/util/error"
import { Message } from "../session/message"
import { Session } from "../session"
import { SessionStore } from "../session/store"
import { Text } from "../prompt/text"
import type { PermissionNext } from "./next"
import { Instance } from "../../infra/project/instance"

/** A draft-only task can research and save the official plan without modifying the project. */
export namespace TaskScope {
  export const DeniedError = NamedError.create("TaskScopeDeniedError", z.object({ message: z.string() }))
  export const BusyError = NamedError.create("TaskScopeBusyError", z.object({ message: z.string() }))
  const active = Instance.state(() => new Set<string>())

  export async function claim(sessionID: string, available?: () => void): Promise<Disposable> {
    const sessions = active()
    try {
      if (sessions.has(sessionID)) throw new Session.BusyError(sessionID)
      available?.()
    } catch (error) {
      if (!(error instanceof Session.BusyError)) throw error
      throw new BusyError({
        message: await Text.pick({
          zh: "子任务正在运行。请等待当前任务结束后再恢复。",
          en: "The child task is running. Wait for it to finish before resuming it.",
        }),
      })
    }
    sessions.add(sessionID)
    return {
      [Symbol.dispose]: () => {
        sessions.delete(sessionID)
      },
    }
  }
  const draft =
    /只出稿|先供审核|只读(?:审查|调研)?|不要(?:修改|编辑|实施)|不(?:修改|编辑)项目|\bdraft only\b|\bfor review(?: first)?\b|\bdo not (?:modify|edit|implement)\b|\bno code changes\b/i
  const research = new Set([
    "read",
    "external_read",
    "sensitive_read",
    "glob",
    "grep",
    "ls",
    "lsp",
    "bash_readonly",
    "webfetch",
    "websearch",
    "codesearch",
    "network",
    "skill",
    "rule",
    "question",
    "todowrite",
    "doom_loop",
    "subagent",
    "delegate",
    "tool_search",
    "plan_generate",
    "plan_edit",
    "plan_read_chunk",
    "plan_simplify",
  ])

  export async function current(
    sessionID: string,
    messageID?: string,
    requireSource = false,
  ): Promise<"draft" | undefined> {
    if (!SessionStore.find(sessionID)) return requireSource ? "draft" : undefined
    const origin = SessionStore.find(sessionID)?.taskOrigin
    if (
      origin &&
      origin.sessionID !== sessionID &&
      (await current(origin.sessionID, origin.messageID, true)) === "draft"
    )
      return "draft"
    const root = await Session.rootID(sessionID)
    let before: string | undefined
    if (messageID) {
      const selected = await Message.get({ sessionID, messageID }).catch(() => undefined)
      const user =
        selected?.info.role === "assistant"
          ? await Message.get({ sessionID, messageID: selected.info.parentID }).catch(() => undefined)
          : selected
      if (!user && requireSource) return "draft"
      if (user?.info.role === "user") {
        const texts = Message.userSourceTexts(user)
        if (texts.length) return draft.test(texts.join("\n")) ? "draft" : undefined
        const origins = user.parts.flatMap((part) => {
          if (part.type !== "text" || !part.synthetic) return []
          const values = [
            part.metadata?.taskOriginMessageID,
            ...(Array.isArray(part.metadata?.taskOriginMessageIDs) ? part.metadata.taskOriginMessageIDs : []),
          ]
          return values.filter((value): value is string => typeof value === "string" && value < user.info.id)
        })
        if (origins.length) {
          for (const messageOrigin of new Set(origins))
            if ((await current(sessionID, messageOrigin, true)) === "draft") return "draft"
          return
        }
        before = user.info.id
      }
    }
    for (const history of origin ? [sessionID] : new Set([sessionID, root])) {
      for await (const message of Message.stream(history)) {
        if (message.info.role !== "user") continue
        if (before && message.info.id > before) continue
        const texts = Message.userSourceTexts(message)
        if (texts.some((text) => text.trim())) return draft.test(texts.join("\n")) ? "draft" : undefined
      }
    }
  }

  export async function bind(childID: string, parentID: string, messageID: string) {
    await Session.update(
      childID,
      (child) => {
        child.taskOrigin = { sessionID: parentID, messageID }
      },
      { touch: false },
    )
  }

  export async function assert(sessionID: string, checks: PermissionNext.Check[], messageID?: string) {
    if (!checks.every((check) => research.has(check.permission)) && SessionStore.find(sessionID)) {
      const { SessionPlan } = await import("../session/plan")
      if ((await SessionPlan.get(sessionID)).status === "paused")
        throw new SessionPlan.PausedError({
          message: await Text.pick({
            zh: "计划执行已暂停。请更换大窗口模型后恢复原执行，或先结束原执行。",
            en: "Plan execution is paused. Select a larger context window to resume the same execution, or end it first.",
          }),
        })
    }
    if ((await current(sessionID, messageID)) !== "draft" || checks.every((check) => research.has(check.permission)))
      return
    throw new DeniedError({
      message: await Text.pick({
        zh: "本轮任务只出稿，不能修改项目或运行有副作用的操作。",
        en: "This task is draft-only. Project changes and operations with side effects are not authorized.",
      }),
    })
  }
}
