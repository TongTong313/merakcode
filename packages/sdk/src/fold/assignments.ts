import type { EngineEvent, ToolTodo } from "../protocol.gen"

export type Todo = ToolTodo
export type Assignee = { member: string; claim: string; status: string }
export type AssignmentRow = {
  id: string
  title: string
  parent?: string
  status: string
  assignees: Assignee[]
  /** The latest progress line of any claim on the task. */
  progress?: string
}
export type Assignments = {
  /** Every task of the group in creation order: the Leader's split of the work. */
  tasks: AssignmentRow[]
  /** The latest todo list of each member by member id; the Leader's is at the Leader's id. */
  todos: Record<string, Todo[]>
  lastSeq: number
}

export function emptyAssignments(): Assignments {
  return { tasks: [], todos: {}, lastSeq: 0 }
}

/** Folds the event stream of one group into the view of who does what. */
export function applyToAssignments(view: Assignments, event: EngineEvent): Assignments {
  const seq = event.seq ?? 0
  if (!event.stream.startsWith("group:") || seq <= view.lastSeq) return view
  const next: Assignments = { ...view, lastSeq: seq }
  switch (event.type) {
    case "task.created":
    case "task.bound":
    case "task.opened":
    case "task.queued":
    case "task.started":
    case "task.reported":
    case "task.reviewed":
    case "task.updated":
    case "task.closed":
    case "phase.changed": {
      const card = event.payload
      const previous = view.tasks.find((row) => row.id === card.id)
      const row: AssignmentRow = {
        id: card.id,
        title: card.title,
        ...(card.parent ? { parent: card.parent } : {}),
        status: card.status,
        assignees: (card.claims ?? []).map((claim) => ({
          member: claim.member,
          claim: claim.id,
          status: claim.status,
        })),
        ...(previous?.progress ? { progress: previous.progress } : {}),
      }
      next.tasks = previous
        ? view.tasks.map((existing) => (existing.id === card.id ? row : existing))
        : [...view.tasks, row]
      break
    }
    case "task.progress":
      next.tasks = view.tasks.map((row) =>
        row.id === event.scope.task ? { ...row, progress: event.payload.summary } : row,
      )
      break
    case "todo.updated": {
      const member = event.actor.id
      if (!member) break
      next.todos = { ...view.todos, [member]: structuredClone(event.payload.items ?? []) }
      break
    }
  }
  return next
}
