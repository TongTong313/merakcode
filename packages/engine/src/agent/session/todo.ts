import { BusEvent } from "../../infra/bus/bus-event"
import { Bus } from "../../infra/bus"
import z from "zod"
import { Storage } from "../../infra/storage/storage"

export namespace Todo {
  export const Info = z
    .object({
      content: z.string().describe("Brief description of the task"),
      status: z.string().describe("Current status of the task: pending, in_progress, completed, cancelled"),
      priority: z.string().describe("Priority level of the task: high, medium, low"),
      id: z.string().describe("Unique identifier for the todo item"),
    })
    .meta({ ref: "Todo" })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define(
      "todo.updated",
      z.object({
        sessionID: z.string(),
        todos: z.array(Info),
      }),
    ),
  }

  export async function update(input: { sessionID: string; todos: Info[] }) {
    await Storage.write(["todo", input.sessionID], input.todos)
    Bus.publish(Event.Updated, input)
  }

  /** Rewrites the list from its current value in one transaction, so concurrent changes are not lost */
  export async function patch(sessionID: string, fn: (todos: Info[]) => Info[]) {
    const todos = await Storage.update<Info[]>(
      ["todo", sessionID],
      (draft) => {
        draft.splice(0, draft.length, ...fn([...draft]))
      },
      () => [],
    )
    Bus.publish(Event.Updated, { sessionID, todos })
    return todos
  }

  export async function get(sessionID: string) {
    return Storage.read<Info[]>(["todo", sessionID])
      .then((x) => x || [])
      .catch(() => [])
  }
}
