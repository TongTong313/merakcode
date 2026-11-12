import ChevronRight from "lucide-solid/icons/chevron-right"
import { useNavigate } from "@solidjs/router"
import { createSignal, For, Show } from "solid-js"
import type { AssignmentRow, GroupMember, Todo } from "@merakcode/sdk"
import { t } from "../../i18n"
import { taskPath } from "../../lib/route"
import { Avatar } from "../../ui/avatar"

const done = new Set(["done", "failed", "cancelled"])

/** One task the Leader split off: who does it, how far it is and the latest thing its worker said. */
function Row(props: { row: AssignmentRow; members: readonly GroupMember[]; depth: number }) {
  const navigate = useNavigate()
  const name = (id: string) => props.members.find((member) => member.id === id)?.name ?? id
  const active = () => props.row.assignees.filter((assignee) => assignee.status !== "abandoned")
  return (
    <button
      class="breakdown-row"
      classList={{ finished: done.has(props.row.status) }}
      style={{ "--depth": String(props.depth) }}
      data-task={props.row.id}
      data-status={props.row.status}
      onClick={() => navigate(taskPath(props.row.id))}
    >
      <span class="breakdown-title ellipsis">{props.row.title}</span>
      <span class="breakdown-meta">
        <span class="badge neutral">{t(`task.status.${props.row.status as "open"}`)}</span>
        <Show when={active().length} fallback={<span class="subtle">{t("group.unassigned")}</span>}>
          <For each={active()}>
            {(assignee) => (
              <span class="breakdown-assignee" title={name(assignee.member)} data-assignee={assignee.member}>
                <Avatar id={assignee.member} name={name(assignee.member)} />
              </span>
            )}
          </For>
        </Show>
      </span>
      <Show when={props.row.progress}>
        <span class="breakdown-progress subtle">{props.row.progress}</span>
      </Show>
    </button>
  )
}

/** The Leader's own checklist, as it keeps it with the todo tool. Cancelled items are left out. */
function LeaderTodo(props: { todos: readonly Todo[] }) {
  const [open, setOpen] = createSignal(true)
  const items = () => props.todos.filter((item) => item.status !== "cancelled")
  const finished = () => items().filter((item) => item.status === "completed").length
  return (
    <Show when={items().length}>
      <div class="group-todo-card" aria-label={t("group.leaderTodo")} role="group">
        <button class="group-todo-head" aria-expanded={open()} onClick={() => setOpen(!open())}>
          <ChevronRight class="icon icon-sm chevron" />
          <span class="group-todo-count">{t("group.todo", { done: finished(), total: items().length })}</span>
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
    </Show>
  )
}

/** The split of the work in the right column: every task of the group with its subtasks, then the Leader's to-do list. */
export function Breakdown(props: {
  rows: readonly AssignmentRow[]
  members: readonly GroupMember[]
  todos: readonly Todo[]
}) {
  const roots = () => props.rows.filter((row) => !row.parent || !props.rows.some((other) => other.id === row.parent))
  const children = (id: string) => props.rows.filter((row) => row.parent === id)
  const walk = (row: AssignmentRow, depth: number): { row: AssignmentRow; depth: number }[] => [
    { row, depth },
    ...children(row.id).flatMap((child) => walk(child, depth + 1)),
  ]
  return (
    <section class="breakdown" aria-label={t("group.breakdown")}>
      <h3 class="members-subtitle">{t("group.breakdown")}</h3>
      <Show when={props.rows.length} fallback={<p class="subtle">{t("group.breakdownEmpty")}</p>}>
        <For each={roots().flatMap((root) => walk(root, 0))}>
          {(entry) => <Row row={entry.row} members={props.members} depth={entry.depth} />}
        </For>
      </Show>
      <LeaderTodo todos={props.todos} />
    </section>
  )
}
