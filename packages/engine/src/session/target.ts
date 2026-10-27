import { z } from "zod"
import { randomUUID } from "node:crypto"
import { Session } from "."
import { SessionStore } from "./store"
import { productState, withProduct } from "../agent-connection/state"
import { settleExternal } from "../agent-connection/runtime"
import { Lock } from "../util/lock"
import { ExternalBlockedError, ExternalOperationError, TakeoverConflictError } from "./external-error"
import type { SessionRunner } from "./runner"
import { Message } from "./message"
import { Storage } from "../storage/storage"
import { Text } from "../util/text"

export namespace SessionTarget {
  export const Schema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("merak") }),
    z.object({
      kind: z.literal("external"),
      productID: z
        .string()
        .regex(/^[A-Za-z0-9_-]+$/)
        .refine((id) => id !== "merak"),
    }),
  ])
  export type Value = z.infer<typeof Schema>
  export const Block = z.object({
    blockID: z.string(),
    productID: z.string(),
    disabledCycleID: z.string(),
    decision: z.enum(["pending", "declined"]),
  })
  export const Fields = {
    target: Schema.optional(),
    targetRevision: z.number().int().nonnegative().optional(),
    targetBlock: Block.optional(),
    takeover: z.object({ at: z.number(), fromProductID: z.string(), blockID: z.string() }).optional(),
    readOnlyReason: z.literal("imported-external-history").optional(),
  }
  export const Decision = z.object({
    decision: z.enum(["accept", "decline"]),
    expectedTargetRevision: z.number().int().nonnegative(),
    blockID: z.string(),
  })

  export async function assertCreatable(input?: {
    target?: Value
    parentID?: string
    metadata?: Record<string, unknown>
  }) {
    if (input?.target?.kind !== "external") return
    if (input.parentID || input.metadata?.group === true)
      throw new ExternalOperationError({
        message: await Text.pick({
          zh: "外部产品仅支持单聊目标",
          en: "External targets are available only for direct conversations",
        }),
      })
    const state = await productState(input.target.productID)
    if (!state.present)
      throw new ExternalOperationError({
        message: await Text.pick({ zh: "产品尚未配置", en: "The product is not configured" }),
      })
    if (!state.enabled)
      throw new ExternalBlockedError({
        message: await Text.pick({ zh: "产品已关闭", en: "The product is disabled" }),
      })
  }

  export async function takeover(sessionID: string, input: z.infer<typeof Decision>) {
    await Session.get(sessionID)
    if (input.decision === "accept") {
      await settleExternal(sessionID)
      await import("./external").then((module) => module.ExternalSession.settle(sessionID))
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

  export async function refresh(input: Session.Info): Promise<Session.Info> {
    if (input.target?.kind !== "external" || input.readOnlyReason) return input
    using _ = await Lock.write(`session-target:${input.id}`)
    const session = SessionStore.find(input.id) ?? input
    if (session.target?.kind !== "external") return session
    const state = await productState(session.target.productID)
    const block = session.targetBlock
    if (state.enabled && !block) return session
    if (!state.enabled && block?.disabledCycleID === state.disabledCycleID) return session
    return Session.updateByProject(
      session.id,
      session.projectID,
      (draft) => {
        draft.targetBlock = state.enabled
          ? undefined
          : {
              blockID: randomUUID(),
              productID: session.target!.kind === "external" ? session.target!.productID : "",
              disabledCycleID: state.disabledCycleID!,
              decision: "pending",
            }
        draft.targetRevision = (draft.targetRevision ?? 0) + 1
      },
      { touch: false },
    )
  }

  export async function assertCanSend(sessionID: string, input?: SessionRunner.PromptInput) {
    const session = await Session.get(sessionID)
    if (session.readOnlyReason)
      throw new ExternalOperationError({
        message: await Text.pick({ zh: "导入的外部对话历史为只读", en: "Imported external history is read-only" }),
      })
    if (session.targetBlock)
      throw new ExternalBlockedError({
        message: await Text.pick({
          zh: "请重新启用此产品，或明确同意由 MerakCode 接管",
          en: "Enable this product or explicitly accept takeover",
        }),
      })
    await assertNewMessage(session, input)
    if (session.target?.kind !== "external") return session
    if (
      input &&
      (input.model ||
        input.agent ||
        input.variant ||
        input.system ||
        input.tools ||
        input.format ||
        input.noReply ||
        input.parts.some((part) => part.type !== "text"))
    )
      throw new ExternalOperationError({
        message: await Text.pick({
          zh: "外部对话仅支持文本和权限模式",
          en: "External conversations accept text and permission mode only",
        }),
      })
    return session
  }

  export async function assertNewMessage(
    session: Session.Info,
    input?: { messageID?: string; parts?: { id?: string }[] },
  ) {
    if (!input || (session.target?.kind !== "external" && !session.takeover)) return
    const existing = input.messageID
      ? await Message.get({ sessionID: session.id, messageID: input.messageID }).catch((error) => {
          if (error instanceof Storage.NotFoundError) return undefined
          throw error
        })
      : undefined
    const partIDs = new Set((input.parts ?? []).flatMap((part) => (part.id ? [part.id] : [])))
    const history = input.messageID || partIDs.size ? await Session.messages({ sessionID: session.id }) : []
    if (
      existing ||
      history.some(
        (message) =>
          (input.messageID &&
            Message.isExternal(message.info) &&
            message.info.role === "user" &&
            message.info.metadata?.externalClientMessageID === input.messageID) ||
          message.parts.some((part) => partIDs.has(part.id)),
      )
    )
      throw new ExternalOperationError({
        message: await Text.pick({
          zh: "包含外部产品历史的对话不支持编辑或重发已有消息",
          en: "Existing messages cannot be edited or resent in conversations with external product history",
        }),
      })
  }

  export async function assertNativeOperation(sessionID: string, history = false) {
    const session = await Session.get(sessionID)
    if (
      session.readOnlyReason ||
      session.target?.kind === "external" ||
      (history && (await Session.messages({ sessionID })).some((message) => Message.isExternal(message.info)))
    )
      throw new ExternalOperationError({
        message: await Text.pick({
          zh: "外部对话历史不支持此操作",
          en: "This operation is unavailable for external conversation history",
        }),
      })
    return session
  }
}
