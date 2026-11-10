import type { EngineEvent, TaskCard, WorkspaceIntegration, WorkspacePublished } from "../protocol.gen"

export type TaskStatus =
  "draft" | "open" | "queued" | "running" | "review" | "blocked" | "done" | "failed" | "cancelled"
export type GoalRow = { id: string; title: string; status: string; owner?: string; phase?: string }
export type BoardCard = TaskCard & {
  progress?: Record<string, string>
  queue?: Record<string, number>
  merges?: Record<string, WorkspaceIntegration & { status: "queued" | "done" | "conflicted" }>
  artifacts?: WorkspacePublished[]
}
export type Board = {
  columns: Record<TaskStatus, BoardCard[]>
  goals: GoalRow[]
  lastSeq: number
  queueOrder: string[]
  streams?: Record<string, number>
}

export function emptyBoard(): Board {
  return {
    columns: {
      draft: [],
      open: [],
      queued: [],
      running: [],
      review: [],
      blocked: [],
      done: [],
      failed: [],
      cancelled: [],
    },
    goals: [],
    lastSeq: 0,
    queueOrder: [],
  }
}

/** Applies host task state and independent remote progress streams. */
export function applyToBoard(board: Board, event: EngineEvent): Board {
  const grouped = event.stream.startsWith("group:")
  if (!grouped && (!event.stream.startsWith("device:") || event.type !== "task.progress")) return board
  const previousSeq = grouped ? board.lastSeq : (board.streams?.[event.stream] ?? 0)
  if (!event.seq || event.seq <= previousSeq) return board
  if (grouped && event.seq !== previousSeq + 1) throw new Error("Board event sequence gap")
  const next: Board = grouped
    ? { ...board, lastSeq: event.seq }
    : { ...board, streams: { ...board.streams, [event.stream]: event.seq } }
  switch (event.type) {
    case "task.created":
    case "task.opened":
    case "task.queued":
    case "task.started":
    case "task.reported":
    case "task.reviewed":
    case "task.updated":
    case "task.closed":
    case "phase.changed": {
      const previous = Object.values(board.columns)
        .flat()
        .find((card) => card.id === event.payload.id)
      const card: BoardCard = {
        ...(previous
          ? {
              progress: previous.progress,
              queue: previous.queue,
              merges: previous.merges,
              artifacts: previous.artifacts,
            }
          : {}),
        ...structuredClone(event.payload),
      }
      if (!Object.hasOwn(board.columns, card.status)) throw new Error("Unknown task status")
      next.columns = { ...board.columns }
      for (const status of Object.keys(next.columns) as TaskStatus[]) {
        next.columns[status] = board.columns[status].filter((previous) => previous.id !== card.id)
      }
      next.columns[card.status as TaskStatus].push(card)
      next.columns[card.status as TaskStatus].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
      if (!card.parent) {
        const goal: GoalRow = {
          id: card.id,
          title: card.title,
          status: card.status,
          owner: card.createdBy.id,
          phase: card.phase,
        }
        next.goals = [...board.goals.filter((previous) => previous.id !== card.id), goal]
        next.goals.sort((a, b) => a.id.localeCompare(b.id))
      }
      updateQueue(next)
      break
    }
    case "task.progress":
      changeCard(next, event.scope.task, (card) => ({
        ...card,
        progress: { ...card.progress, [event.payload.claim]: event.payload.summary },
      }))
      break
    case "merge.queued":
    case "merge.done":
    case "merge.conflicted": {
      const status = event.type === "merge.queued" ? "queued" : event.type === "merge.done" ? "done" : "conflicted"
      changeCard(next, event.scope.task, (card) => ({
        ...card,
        merges: { ...card.merges, [event.payload.claim]: { ...structuredClone(event.payload), status } },
      }))
      break
    }
    case "artifact.published":
      changeCard(next, event.scope.task, (card) => ({
        ...card,
        artifacts: [
          ...(card.artifacts ?? []).filter((item) => item.id !== event.payload.id),
          structuredClone(event.payload),
        ],
      }))
      break
  }
  return next
}

function changeCard(board: Board, id: string | undefined, change: (card: BoardCard) => BoardCard) {
  board.columns = Object.fromEntries(
    Object.entries(board.columns).map(([status, cards]) => [
      status,
      cards.map((card) => (card.id === id ? change(card) : card)),
    ]),
  ) as Board["columns"]
}

function updateQueue(board: Board) {
  const pending = Object.values(board.columns)
    .flat()
    .flatMap((card) =>
      (card.claims ?? [])
        .filter((claim) => claim.status === "queued")
        .map((claim) => ({ ...claim, priority: card.priority })),
    )
  const ids = new Set(pending.map((claim) => claim.id))
  const order = board.queueOrder.filter((id) => ids.has(id))
  for (const claim of pending) if (!order.includes(claim.id)) order.push(claim.id)
  board.queueOrder = order
  pending.sort((a, b) => b.priority - a.priority || order.indexOf(a.id) - order.indexOf(b.id))
  const positions = new Map<string, number>()
  const members = new Map<string, number>()
  for (const claim of pending) {
    const position = (members.get(claim.member) ?? 0) + 1
    positions.set(claim.id, position)
    members.set(claim.member, position)
  }
  board.columns = Object.fromEntries(
    Object.entries(board.columns).map(([status, cards]) => [
      status,
      cards.map((card) => {
        const queue: Record<string, number> = {}
        for (const claim of card.claims ?? []) {
          const position = positions.get(claim.id)
          if (position !== undefined) queue[claim.id] = position
        }
        if (!card.queue && Object.keys(queue).length === 0) return card
        const updated: BoardCard = { ...card, queue }
        if (Object.keys(queue).length === 0) delete updated.queue
        return updated
      }),
    ]),
  ) as Board["columns"]
}
