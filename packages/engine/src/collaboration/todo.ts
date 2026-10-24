/** The group todo item a delegation drives, found or added once and then changed by id */
import { Todo } from "../session/todo"

/** Marks the item in progress: the one named by id when it still exists, otherwise a new "@name task (paths)" */
export async function startTodo(
  sessionID: string,
  input: { id?: string; seat: string; task: string; paths: string[] },
) {
  let claimed = ""
  await Todo.patch(sessionID, (todos) => {
    const found = input.id ? todos.find((item) => item.id === input.id) : undefined
    if (found) {
      claimed = found.id
      return todos.map((item) => (item.id === found.id ? { ...item, status: "in_progress" } : item))
    }
    // Short, since the leader reads it back as "(id: …)"
    claimed = crypto.randomUUID().slice(0, 8)
    const suffix = input.paths.length ? ` (${input.paths.join(", ")})` : ""
    return [
      ...todos,
      { id: claimed, content: `@${input.seat} ${input.task}${suffix}`, status: "in_progress", priority: "medium" },
    ]
  })
  return claimed
}

/** Sets the item's status; nothing happens when the leader has removed it meanwhile */
export async function setTodo(sessionID: string, id: string, status: "pending" | "completed" | "cancelled") {
  await Todo.patch(sessionID, (todos) => todos.map((item) => (item.id === id ? { ...item, status } : item)))
}
