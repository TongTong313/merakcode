import type { CollaborationGroup, Todo } from "@merakcode/sdk/client"
import { createEffect, createSignal, on, onCleanup } from "solid-js"
import { call, client } from "../../state/client"
import { listen } from "../../state/store"
import { agentConnections, loadConnections } from "../../state/agent-connections"

/** A group conversation's record, the products a seat can use and the group todo; refreshed by events */
export function groupState(input: { sessionID: () => string; directory: () => string; enabled: () => boolean }) {
  const [group, setGroup] = createSignal<CollaborationGroup>()
  const [todos, setTodos] = createSignal<Todo[]>([])
  let generation = 0
  let groupRequest = 0
  const refresh = () => {
    const sessionID = input.sessionID()
    const directory = input.directory()
    const current = ++groupRequest
    return call(client(directory).collaboration.get({ sessionID }))
      .then((value) => {
        if (
          current === groupRequest &&
          input.enabled() &&
          sessionID === input.sessionID() &&
          directory === input.directory()
        )
          setGroup(value)
      })
      .catch(() => undefined)
  }

  createEffect(
    on([input.sessionID, input.directory, input.enabled], ([sessionID, directory, enabled]) => {
      const current = ++generation
      groupRequest++
      setGroup(undefined)
      setTodos([])
      if (!enabled) return
      void refresh()
      void loadConnections().catch(() => undefined)
      void call(client(directory).session.todo({ sessionID }))
        .then((value) => {
          if (current === generation && input.enabled()) setTodos(value)
        })
        .catch(() => undefined)
    }),
  )
  onCleanup(
    listen((_directory, event) => {
      if (!input.enabled()) return
      if (event.type === "collaboration.updated" && event.properties.sessionID === input.sessionID()) void refresh()
      // Products are turned on, added or changed in settings or in a config file
      if (event.type === "config.updated") void refresh()
      if (event.type === "todo.updated" && event.properties.sessionID === input.sessionID())
        setTodos(event.properties.todos)
    }),
  )
  return { group, products: agentConnections, todos }
}
