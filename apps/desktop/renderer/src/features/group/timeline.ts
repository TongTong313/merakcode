import type { EngineEvent, ModelPart } from "@merakcode/sdk"

export type ChatItem =
  | {
      kind: "human"
      id: string
      authorID: string
      text: string
      to: string[]
      status: "" | "delivered" | "processing"
      deliveredTo: string[]
    }
  | { kind: "reply"; id: string; authorID: string; text: string }
  | { kind: "work"; id: string; authorID: string; session: string; parts: ModelPart[] }
  | { kind: "task"; id: string; task: string; authorID: string }
  | { kind: "progress"; id: string; authorID: string; text: string; task: string }

const textOf = (parts: readonly ModelPart[] | null | undefined) =>
  (parts ?? [])
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n")

/**
 * The group chat: what people said, what the Leader answered and did, the tasks it created and how the work goes,
 * in the order it happened. `say` is how the Leader speaks, so it shows as a reply and not as work.
 */
export function chatItems(
  events: readonly EngineEvent[],
  context: { claimMember: (claim: string) => string | undefined },
) {
  const ordered = events.toSorted((a, b) => a.id.localeCompare(b.id))
  const delivered = new Set<string>()
  const processing = new Set<string>()
  const deliveredTo = new Map<string, string[]>()
  const latestProgress = new Map<string, string>()
  for (const event of ordered) {
    if (event.type === "task.progress") latestProgress.set(event.payload.claim, event.id)
    if (!event.cause) continue
    if (event.type === "notice.sent" && event.payload.kind === "receipt") delivered.add(event.cause)
    if (event.type === "input.consumed") processing.add(event.cause)
    if (event.type === "input.delivered") {
      delivered.add(event.cause)
      const member = context.claimMember(event.payload.claim)
      if (member) deliveredTo.set(event.cause, [...(deliveredTo.get(event.cause) ?? []), member])
    }
  }
  return ordered.flatMap((event): ChatItem[] => {
    if (event.type === "human.said")
      return [
        {
          kind: "human",
          id: event.id,
          authorID: event.actor.id ?? "",
          text: event.payload.text,
          to: event.payload.to ?? [],
          status: processing.has(event.id) ? "processing" : delivered.has(event.id) ? "delivered" : "",
          deliveredTo: deliveredTo.get(event.id) ?? [],
        },
      ]
    if (event.type === "message.completed" && event.payload.role === "assistant") {
      const authorID = event.actor.id ?? ""
      if (event.stream.startsWith("group:"))
        return [{ kind: "reply", id: event.id, authorID, text: textOf(event.payload.parts) }]
      const parts = (event.payload.parts ?? []).filter((part) => part.toolCall?.name !== "say")
      if (!parts.length || !event.scope.session) return []
      return [{ kind: "work", id: event.id, authorID, session: event.scope.session, parts }]
    }
    if (event.type === "task.created" && event.stream.startsWith("group:"))
      return [{ kind: "task", id: event.id, task: event.payload.id, authorID: event.actor.id ?? "" }]
    if (event.type === "task.progress" && latestProgress.get(event.payload.claim) === event.id)
      return [
        {
          kind: "progress",
          id: event.id,
          authorID: context.claimMember(event.payload.claim) ?? event.actor.id ?? "",
          text: event.payload.summary,
          task: event.scope.task ?? "",
        },
      ]
    return []
  })
}

/** The text of a `say` call; while the call streams in, its input is a JSON string that is not finished yet. */
export function sayText(input: unknown): string {
  if (input && typeof input === "object") {
    const value = (input as { text?: unknown }).text
    return typeof value === "string" ? value : ""
  }
  if (typeof input !== "string") return ""
  const match = /"text"\s*:\s*"((?:[^"\\]|\\.)*)/s.exec(input)
  if (!match) return ""
  let body = match[1]!
  // A half-written escape at the end is not text yet
  if (/(?:^|[^\\])(?:\\\\)*\\$/.test(body)) body = body.slice(0, -1)
  try {
    return JSON.parse(`"${body}"`)
  } catch {
    return body
  }
}
