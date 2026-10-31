import { SessionTarget } from "../agent/session/target"
import { SessionStore } from "../agent/session/store"
import { withProduct } from "../agent/external/state"
import { settleExternal } from "../agent/external/runtime"
import { Lock } from "../infra/concurrency/lock"
import { ExternalOperationError, TakeoverConflictError } from "../agent/session/external-error"
import { Text } from "../agent/prompt/text"
import z from "zod"
import { fn } from "@merakcode/util/fn"
import { Identifier } from "@merakcode/util/id"
import { Session } from "../agent/session"
import { Loop } from "../agent/loop"
import { SessionCrash } from "../agent/loop/crash-reconcile"
import { ExternalSession } from "../agent/loop/external"
import { CronScheduler } from "./task/cron"
import { Command } from "../agent/prompt/command"

export namespace SessionOperations {
  export async function takeover(sessionID: string, input: z.infer<typeof SessionTarget.Decision>) {
    await Session.get(sessionID)
    if (input.decision === "accept") {
      await settleExternal(sessionID)
      await ExternalSession.settle(sessionID)
    }
    using _ = await Lock.write(`session-target:${sessionID}`)
    const session = SessionStore.find(sessionID)!
    if (session.readOnlyReason)
      throw new ExternalOperationError({
        message: await Text.pick({ zh: "导入的外部对话历史为只读", en: "Imported external history is read-only" }),
      })
    const block = session.targetBlock
    if (input.decision === "accept" && session.target?.kind === "merak" && session.takeover?.blockID === input.blockID)
      return session
    if (input.decision === "decline" && block?.blockID === input.blockID && block.decision === "declined")
      return session
    if (!block || block.blockID !== input.blockID || (session.targetRevision ?? 0) !== input.expectedTargetRevision)
      throw new TakeoverConflictError({
        message: await Text.pick({
          zh: "对话目标已变化，请刷新后重新确认",
          en: "The conversation target changed; refresh before deciding again",
        }),
      })
    return withProduct(block.productID, async (state) => {
      if (state.enabled || state.disabledCycleID !== block.disabledCycleID)
        throw new TakeoverConflictError({
          message: await Text.pick({
            zh: "产品状态已变化，请刷新后重新确认",
            en: "The product state changed; refresh before deciding again",
          }),
        })
      return Session.update(
        sessionID,
        (draft) => {
          if (input.decision === "decline") draft.targetBlock!.decision = "declined"
          if (input.decision === "accept") {
            draft.target = { kind: "merak" }
            draft.targetBlock = undefined
            draft.takeover = { at: Date.now(), fromProductID: block.productID, blockID: block.blockID }
          }
          draft.targetRevision = (draft.targetRevision ?? 0) + 1
        },
        { touch: false },
      )
    })
  }

  export const get = fn(Identifier.schema("session"), async (id) => {
    const session = await Session.get(id)
    if (session.target?.kind === "external") await ExternalSession.reconcile(id)
    else await SessionCrash.reconcile(id, () => Boolean(Loop.resume(id)))
    return session
  })

  export const remove = fn(Identifier.schema("session"), async (id) => {
    await Loop.cancelTree(id)
    await CronScheduler.removeBySession(id)
    await Session.removeRecords(id)
  })

  export const initialize = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      modelID: z.string(),
      providerID: z.string(),
      messageID: Identifier.schema("message"),
    }),
    async (input) => {
      await Loop.Request.command({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: input.providerID + "/" + input.modelID,
        command: Command.Default.INIT,
        arguments: "",
      })
    },
  )
}
