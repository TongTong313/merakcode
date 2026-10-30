import z from "zod"
import { ulid } from "ulid"
import { Bus } from "../../infra/bus"
import { BusEvent } from "../../infra/bus/bus-event"
import { Storage } from "../../infra/storage/storage"

export namespace SessionNotification {
  const key = (sessionID: string, id: string) => ["session_notification", sessionID, id]

  const Model = z.object({
    providerID: z.string(),
    modelID: z.string(),
  })

  export const Info = z.object({
    id: z.string(),
    sessionID: z.string(),
    type: z.literal("workflow.finished"),
    createdAt: z.number(),
    text: z.string(),
    agent: z.string().optional(),
    model: Model.optional(),
    deliveredAt: z.number().optional(),
    deliveredMessageID: z.string().optional(),
    attempts: z.number().optional(),
    ackedAt: z.number().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  export type Info = z.infer<typeof Info>

  export const EnqueueInput = Info.omit({
    createdAt: true,
    deliveredAt: true,
    deliveredMessageID: true,
    attempts: true,
    ackedAt: true,
  }).partial({
    id: true,
    metadata: true,
  })
  export type EnqueueInput = z.infer<typeof EnqueueInput>

  export const Event = {
    Created: BusEvent.define(
      "session.notification.created",
      z.object({
        sessionID: z.string(),
        notificationID: z.string(),
      }),
    ),
  }

  export async function enqueue(input: EnqueueInput) {
    if (input.id) {
      const existing = await Storage.read<Info>(key(input.sessionID, input.id)).catch(() => undefined)
      const parsed = Info.safeParse(existing)
      if (parsed.success) return parsed.data
    }
    const info: Info = {
      ...input,
      id: input.id ?? `notification_${ulid()}`,
      createdAt: Date.now(),
    }
    await Storage.write(key(info.sessionID, info.id), info)
    await Bus.publish(Event.Created, {
      sessionID: info.sessionID,
      notificationID: info.id,
    })
    return info
  }

  export async function list(sessionID: string) {
    const items = await Promise.all(
      (await Storage.list(["session_notification", sessionID])).map(async (item) => {
        const info = await Storage.read<Info>(item).catch(() => undefined)
        const parsed = Info.safeParse(info)
        return parsed.success ? parsed.data : undefined
      }),
    )
    return items
      .filter((item): item is Info => item !== undefined)
      .filter((item) => !item.ackedAt)
      .toSorted((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }

  export async function remove(sessionID: string, id: string) {
    await Storage.remove(key(sessionID, id))
  }

  export async function markDelivered(sessionID: string, ids: string[], messageID: string) {
    const deliveredAt = Date.now()
    await Promise.all(
      ids.map(async (id) => {
        await Storage.update<Info>(key(sessionID, id), (draft) => {
          draft.deliveredAt = deliveredAt
          draft.deliveredMessageID = messageID
          draft.attempts = (draft.attempts ?? 0) + 1
        }).catch((error) => {
          if (error instanceof Storage.NotFoundError) return
          throw error
        })
      }),
    )
  }

  export async function ack(sessionID: string, ids: string[]) {
    const ackedAt = Date.now()
    await Promise.all(
      ids.map(async (id) => {
        await Storage.update<Info>(key(sessionID, id), (draft) => {
          draft.ackedAt = ackedAt
        }).catch((error) => {
          if (error instanceof Storage.NotFoundError) return
          throw error
        })
      }),
    )
  }

  export async function drain(sessionID: string) {
    const items = await list(sessionID)
    await Promise.all(items.map((item) => remove(sessionID, item.id)))
    return items
  }

  export function promptText(items: Info[]) {
    return [
      "<system-reminder>",
      "The following background workflow notification(s) were delivered by the system.",
      "These notifications are internal system signals, not direct user messages. Do not thank or acknowledge the notification itself.",
      "Each listed workflow has already reached a terminal status. Do not say it is still running, do not ask the user to wait, and do not call workflow_run again for these completed runs unless the user explicitly asks for a new run.",
      "Present the result directly in this conversation and mention failures only when the notification reports them.",
      "</system-reminder>",
      "",
      ...items.map((item) => item.text),
    ].join("\n")
  }
}
