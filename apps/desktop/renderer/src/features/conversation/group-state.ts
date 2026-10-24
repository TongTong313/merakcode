import type { CollaborationGroup, Todo } from "@merakcode/sdk/client"
import { createEffect, createSignal, on, onCleanup } from "solid-js"
import { call, client } from "../../state/client"
import { listen } from "../../state/store"
import type { Product } from "./members"

/** A group conversation's record, the products a seat can use and the group todo; refreshed by events */
export function groupState(input: { sessionID: () => string; directory: () => string; enabled: () => boolean }) {
  const [group, setGroup] = createSignal<CollaborationGroup>()
  const [products, setProducts] = createSignal<Product[]>([])
  const [todos, setTodos] = createSignal<Todo[]>([])
  const api = () => client(input.directory())
  const refresh = () =>
    call(api().collaboration.get({ sessionID: input.sessionID() }))
      .then(setGroup)
      .catch(() => undefined)
  const refreshProducts = () =>
    call(api().collaboration.products())
      .then(setProducts)
      .catch(() => undefined)

  createEffect(
    on([input.sessionID, input.enabled], ([sessionID, enabled]) => {
      setGroup(undefined)
      setTodos([])
      if (!enabled) return
      void refresh()
      void refreshProducts()
      void call(api().session.todo({ sessionID }))
        .then(setTodos)
        .catch(() => undefined)
    }),
  )
  onCleanup(
    listen((_directory, event) => {
      if (!input.enabled()) return
      if (event.type === "collaboration.updated" && event.properties.sessionID === input.sessionID()) void refresh()
      // Products are turned on, added or changed in settings or in a config file
      if (event.type === "config.updated") void refreshProducts()
      if (event.type === "todo.updated" && event.properties.sessionID === input.sessionID())
        setTodos(event.properties.todos)
    }),
  )
  return { group, products, todos }
}
