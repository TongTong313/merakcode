import type { EngineEvent, EventScope, GroupNotice } from "../protocol.gen"

export type Notice = GroupNotice & { id: string; request?: string; scope: EventScope; time: string }
export type Inbox = { todo: Notice[]; info: Notice[]; lastSeq: number }

export function emptyInbox(): Inbox {
  return { todo: [], info: [], lastSeq: 0 }
}

/** Folds notices and their answers from the complete group stream. */
export function applyToInbox(inbox: Inbox, event: EngineEvent, me: string): Inbox {
  if (!event.stream.startsWith("group:") || !event.seq || event.seq <= inbox.lastSeq) return inbox
  if (event.seq !== inbox.lastSeq + 1) throw new Error("Inbox event sequence gap")
  const next = { ...inbox, lastSeq: event.seq }
  if (event.type === "notice.sent" && event.payload.to?.includes(me)) {
    const notice: Notice = {
      ...structuredClone(event.payload),
      id: event.id,
      request: event.cause,
      scope: { ...event.scope },
      time: event.time,
    }
    const column = ["permission", "question", "review", "plan"].includes(notice.kind) ? "todo" : "info"
    const previous = inbox[column].filter(
      (item) =>
        !(
          ["review", "plan"].includes(notice.kind) &&
          item.kind === notice.kind &&
          item.scope.task === notice.scope.task
        ),
    )
    next[column] = [...previous, notice]
  }
  if (event.type === "permission.replied" || event.type === "question.answered") {
    next.todo = inbox.todo.filter((notice) => !event.cause || notice.request !== event.cause)
  }
  if (event.type === "task.reviewed" || event.type === "task.closed") {
    next.todo = inbox.todo.filter(
      (notice) =>
        notice.scope.task !== event.scope.task ||
        (event.type === "task.reviewed" && notice.kind !== "review" && notice.kind !== "plan"),
    )
  }
  if (event.type === "phase.changed") {
    next.todo = inbox.todo.filter(
      (notice) =>
        notice.scope.task !== event.scope.task ||
        ((notice.kind !== "review" || event.payload.phase === "review") &&
          (notice.kind !== "plan" || event.payload.planPending)),
    )
  }
  return next
}
