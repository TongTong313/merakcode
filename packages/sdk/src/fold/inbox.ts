import type { EngineEvent, EventScope, GroupNotice } from "../protocol.gen"

export type Notice = GroupNotice & { id: string; request?: string; scope: EventScope; time: string }
export type Inbox = {
  todo: Notice[]
  info: Notice[]
  lastSeq: number
  streams?: Record<string, number>
  answered?: string[]
  checkpoints?: Record<string, { review?: string; plan?: string }>
}

export function emptyInbox(): Inbox {
  return { todo: [], info: [], lastSeq: 0 }
}

/** Folds group history and separately delivered device inbox notices. */
export function applyToInbox(inbox: Inbox, event: EngineEvent, me: string): Inbox {
  const grouped = event.stream.startsWith("group:")
  if (
    !grouped &&
    !event.stream.startsWith("inbox:") &&
    !event.stream.startsWith("device:") &&
    !event.stream.startsWith("session:")
  )
    return inbox
  const previousSeq = grouped ? inbox.lastSeq : (inbox.streams?.[event.stream] ?? 0)
  if (!event.seq || event.seq <= previousSeq) return inbox
  if (grouped && event.seq !== previousSeq + 1) throw new Error("Inbox event sequence gap")
  const next: Inbox = grouped
    ? { ...inbox, lastSeq: event.seq }
    : { ...inbox, streams: { ...inbox.streams, [event.stream]: event.seq } }
  const task = event.scope.task
  if (task) {
    const previous = inbox.checkpoints?.[task] ?? {}
    if (
      event.type === "task.reviewed" ||
      event.type === "task.closed" ||
      (event.type === "task.updated" && event.payload.status === "blocked")
    ) {
      next.checkpoints = { ...inbox.checkpoints, [task]: {} }
    } else if (event.type === "phase.changed") {
      next.checkpoints = {
        ...inbox.checkpoints,
        [task]: {
          review: event.payload.phase === "review" ? event.id : undefined,
          plan: event.payload.planPending ? previous.plan : undefined,
        },
      }
    } else if (event.type === "task.reported" && event.payload.status === "review") {
      next.checkpoints = { ...inbox.checkpoints, [task]: { ...previous, review: event.id } }
    } else if (event.type === "task.updated") {
      next.checkpoints = {
        ...inbox.checkpoints,
        [task]: { ...previous, plan: event.payload.planPending ? (previous.plan ?? event.id) : undefined },
      }
    }
  }
  if (event.type === "notice.sent" && event.payload.to?.includes(me)) {
    if (event.cause && inbox.answered?.includes(event.cause)) return next
    const checkpoint = task ? inbox.checkpoints?.[task] : undefined
    const kind = event.payload.kind
    if (checkpoint && (kind === "review" || kind === "plan") && (!checkpoint[kind] || checkpoint[kind] !== event.cause))
      return next
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
    if (event.cause && !inbox.answered?.includes(event.cause)) next.answered = [...(inbox.answered ?? []), event.cause]
  }
  if (event.type === "task.reviewed" || event.type === "task.closed") {
    next.todo = inbox.todo.filter(
      (notice) =>
        notice.scope.task !== event.scope.task ||
        (event.type === "task.reviewed" && notice.kind !== "review" && notice.kind !== "plan"),
    )
  }
  if (event.type === "task.updated" && event.payload.status === "blocked") {
    next.todo = inbox.todo.filter(
      (notice) => notice.scope.task !== event.scope.task || !["review", "plan"].includes(notice.kind),
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
