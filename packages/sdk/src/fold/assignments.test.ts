import { expect, test } from "vitest"
import { applyToAssignments, emptyAssignments, type EngineEvent, type TaskCard } from "../index"

const goal: TaskCard = {
  id: "goal",
  group: "group",
  project: "/work/app",
  title: "Ship the login page",
  description: "",
  acceptance: [],
  priority: 0,
  status: "open",
  claims: [],
  createdBy: { kind: "agent", id: "leader" },
}
const child: TaskCard = { ...goal, id: "child", parent: "goal", title: "Build the form", status: "running" }

let seq = 0
function at(partial: Record<string, unknown>): EngineEvent {
  seq += 1
  return {
    id: `event-${seq}`,
    stream: "group:group",
    seq,
    time: "2026-11-11T00:00:00Z",
    actor: { kind: "agent", id: "leader" },
    scope: { group: "group" },
    ...partial,
  } as EngineEvent
}

test("folds how the Leader split the work: tasks, who holds them, the latest progress, and the Leader's todos", () => {
  seq = 0
  let view = emptyAssignments()
  view = applyToAssignments(view, at({ type: "task.created", scope: { group: "group", task: "goal" }, payload: goal }))
  view = applyToAssignments(
    view,
    at({
      type: "task.updated",
      scope: { group: "group", task: "child" },
      payload: {
        ...child,
        claims: [
          { id: "claim", task: "child", member: "writer", role: "owner", status: "active", session: "run" },
          { id: "old", task: "child", member: "helper", role: "owner", status: "reported", session: "run2" },
        ],
      },
    }),
  )
  view = applyToAssignments(
    view,
    at({
      type: "task.progress",
      scope: { group: "group", task: "child" },
      payload: { claim: "claim", summary: "Form layout done" },
    }),
  )
  view = applyToAssignments(
    view,
    at({
      type: "task.progress",
      scope: { group: "group", task: "child" },
      payload: { claim: "claim", summary: "Validation wired" },
    }),
  )
  view = applyToAssignments(
    view,
    at({
      type: "todo.updated",
      payload: {
        items: [
          { content: "Split the page", status: "done" },
          { content: "Review the form", status: "in_progress" },
        ],
      },
    }),
  )
  view = applyToAssignments(
    view,
    at({
      type: "todo.updated",
      actor: { kind: "agent", id: "writer" },
      payload: { items: [{ content: "Write tests", status: "pending" }] },
    }),
  )

  expect(view.tasks.map((task) => task.id)).toEqual(["goal", "child"])
  const row = view.tasks.find((task) => task.id === "child")
  expect(row).toMatchObject({
    title: "Build the form",
    parent: "goal",
    status: "running",
    progress: "Validation wired",
  })
  expect(row?.assignees).toEqual([
    { member: "writer", claim: "claim", status: "active" },
    { member: "helper", claim: "old", status: "reported" },
  ])
  expect(view.todos.leader).toEqual([
    { content: "Split the page", status: "done" },
    { content: "Review the form", status: "in_progress" },
  ])
  expect(view.todos.writer).toEqual([{ content: "Write tests", status: "pending" }])
})

test("ignores events of other streams and replays without changing earlier snapshots", () => {
  seq = 0
  const first = emptyAssignments()
  const event = at({ type: "task.created", scope: { group: "group", task: "goal" }, payload: goal })
  const created = applyToAssignments(first, event)
  expect(first.tasks).toEqual([])
  expect(created.tasks).toHaveLength(1)
  expect(applyToAssignments(created, event)).toBe(created)
  expect(applyToAssignments(created, { ...at({ type: "task.created", payload: goal }), stream: "session:x" })).toBe(
    created,
  )
})
