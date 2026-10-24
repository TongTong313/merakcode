import type { Todo } from "@merakcode/sdk/client"
import ChevronRight from "lucide-solid/icons/chevron-right"
import { createSignal, For, Show } from "solid-js"
import { t } from "../../i18n"

/** The group todo pinned above the chat: progress on one line, the checklist when opened. Cancelled items are left out. */
export function GroupTodo(props: { todos: readonly Todo[] }) {
  const [open, setOpen] = createSignal(false)
  const items = () => props.todos.filter((item) => item.status !== "cancelled")
  const done = () => items().filter((item) => item.status === "completed").length
  const doing = () => items().find((item) => item.status === "in_progress")
  return (
    <Show when={items().length}>
      <div class="group-todo">
        <div class="group-todo-card">
          <button class="group-todo-head" aria-expanded={open()} onClick={() => setOpen(!open())}>
            <ChevronRight class="icon icon-sm chevron" />
            <span class="group-todo-count">{t("group.todo", { done: done(), total: items().length })}</span>
            <Show when={doing()}>
              {(item) => <span class="subtle ellipsis">{t("group.doing", { content: item().content })}</span>}
            </Show>
          </button>
          <Show when={open()}>
            <ul class="group-todo-list">
              <For each={items()}>
                {(item) => (
                  <li class="group-todo-item" data-status={item.status}>
                    {item.content}
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </div>
    </Show>
  )
}
