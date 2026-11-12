import Archive from "lucide-solid/icons/archive"
import ArchiveRestore from "lucide-solid/icons/archive-restore"
import { useNavigate } from "@solidjs/router"
import { createMemo, createSignal, For, Show } from "solid-js"
import type { TaskCard } from "@merakcode/sdk"
import { t, type Key } from "../../i18n"
import { taskPath } from "../../lib/route"
import { groups } from "../../state/groups"
import { archivedTasks, taskUpdated, tasks } from "../../state/tasks"
import { Confirm } from "../../ui/dialog"
import { Segmented } from "../../ui/segmented"
import { toast } from "../../ui/toast"
import { Sidebar } from "../shell/sidebar"
import { archiveCards, isFinished, restoreCard } from "./archive"

/** The board has one column per stage of the work; finished work of any kind stays in the last column. */
const boardColumns: { id: string; label: Key; statuses: string[] }[] = [
  { id: "todo", label: "board.column.todo", statuses: ["draft", "open"] },
  { id: "queued", label: "task.status.queued", statuses: ["queued"] },
  { id: "running", label: "task.status.running", statuses: ["running"] },
  { id: "review", label: "task.status.review", statuses: ["review"] },
  { id: "blocked", label: "task.status.blocked", statuses: ["blocked"] },
  { id: "done", label: "board.column.done", statuses: ["done", "failed", "cancelled"] },
]

/** The cards of a column, the most recent change first. */
function columnCards(cards: readonly TaskCard[], statuses: readonly string[]) {
  return cards
    .filter((card) => statuses.includes(card.status))
    .toSorted((a, b) => taskUpdated(b.id) - taskUpdated(a.id))
}

const failed = (error: unknown) => toast({ kind: "error", title: t("error.request", { message: "MRK-6001" }), error })

function TaskCardView(props: { card: TaskCard; onOpen: (id: string) => void; onArchive?: (card: TaskCard) => void }) {
  const group = () => groups().find((item) => item.id === props.card.group)
  return (
    <div class="task-card-wrap">
      <button class="task-card" data-task={props.card.id} onClick={() => props.onOpen(props.card.id)}>
        <strong>{props.card.title}</strong>
        <span class="subtle ellipsis">{group()?.name ?? t("board.noGroup")}</span>
        <Show when={isFinished(props.card)}>
          <span class="badge neutral">{t(`task.status.${props.card.status as "done" | "failed" | "cancelled"}`)}</span>
        </Show>
      </button>
      <Show when={props.onArchive}>
        {(archive) => (
          <button
            class="icon-button sm task-card-archive"
            aria-label={t("tasks.archiveCard", { title: props.card.title })}
            title={t("tasks.archive")}
            onClick={() => archive()(props.card)}
          >
            <Archive class="icon icon-sm" />
          </button>
        )}
      </Show>
    </div>
  )
}

/** The tasks of this client by stage. Without finished work it is the compact board of the home page. */
export function TaskColumns(props: {
  finished?: boolean
  onOpen: (id: string) => void
  onArchive?: (card: TaskCard) => void
  onArchiveAll?: (cards: TaskCard[]) => void
}) {
  const shown = () => boardColumns.filter((column) => props.finished || column.id !== "done")
  return (
    <div class="task-columns" role="group" aria-label={t("home.board")}>
      <For each={shown()}>
        {(column) => {
          const cards = () => columnCards(tasks(), column.statuses)
          return (
            <section class="task-column" aria-label={t(column.label)} data-column={column.id}>
              <h3>
                <span>
                  {t(column.label)} <span class="count">{cards().length}</span>
                </span>
                <Show when={column.id === "done" && props.onArchiveAll && cards().length}>
                  <button class="button ghost sm" onClick={() => props.onArchiveAll?.(cards())}>
                    {t("tasks.archiveAllCount", { count: cards().length })}
                  </button>
                </Show>
              </h3>
              <For each={cards()}>
                {(card) => <TaskCardView card={card} onOpen={props.onOpen} onArchive={props.onArchive} />}
              </For>
            </section>
          )
        }}
      </For>
    </div>
  )
}

/** Archived tasks: found by their words, brought back to the board with one click. */
function ArchiveList(props: { onOpen: (id: string) => void }) {
  const [query, setQuery] = createSignal("")
  const found = createMemo(() => {
    const needle = query().trim().toLowerCase()
    return archivedTasks()
      .filter((card) => !needle || `${card.title}\n${card.description}`.toLowerCase().includes(needle))
      .toSorted((a, b) => taskUpdated(b.id) - taskUpdated(a.id))
  })
  return (
    <section class="archive-list" aria-label={t("tasks.archived")}>
      <input
        class="input"
        aria-label={t("tasks.search")}
        placeholder={t("tasks.search")}
        value={query()}
        onInput={(event) => setQuery(event.currentTarget.value)}
      />
      <Show
        when={found().length}
        fallback={<p class="subtle">{archivedTasks().length ? t("tasks.noMatch") : t("tasks.archivedEmpty")}</p>}
      >
        <For each={found()}>
          {(card) => (
            <article class="card archive-row" data-archived={card.id}>
              <button class="task-card" onClick={() => props.onOpen(card.id)}>
                <strong>{card.title}</strong>
                <span class="subtle ellipsis">{t(`task.status.${card.status as "done"}`)}</span>
              </button>
              <button
                class="button secondary sm"
                aria-label={t("tasks.restoreCard", { title: card.title })}
                onClick={() => void restoreCard(card.id).catch(failed)}
              >
                <ArchiveRestore class="icon icon-sm" />
                {t("tasks.restore")}
              </button>
            </article>
          )}
        </For>
      </Show>
    </section>
  )
}

/** The global board: every task of this client by stage; finished work is archived from here and found again. */
export function TaskBoardPage() {
  const navigate = useNavigate()
  const [view, setView] = createSignal<"board" | "archived">("board")
  const [confirming, setConfirming] = createSignal<TaskCard>()
  const open = (id: string) => navigate(taskPath(id))
  const archive = (card: TaskCard) => {
    if (!isFinished(card)) {
      setConfirming(card)
      return
    }
    void archiveCards([card]).catch(failed)
  }
  return (
    <div class="app">
      <Sidebar />
      <main class="main">
        <div class="topbar drag">
          <span class="title">{t("tasks.title")}</span>
          <span class="spacer" />
          <div class="no-drag row">
            <Segmented
              label={t("tasks.title")}
              value={view()}
              onChange={setView}
              options={[
                { value: "board", label: t("tasks.title") },
                { value: "archived", label: t("tasks.archived") },
              ]}
            />
          </div>
        </div>
        <div class="settings-body scroll">
          <div class="tasks-page">
            <Show when={view() === "board"} fallback={<ArchiveList onOpen={open} />}>
              <TaskColumns
                finished
                onOpen={open}
                onArchive={archive}
                onArchiveAll={(cards) => void archiveCards(cards).catch(failed)}
              />
            </Show>
          </div>
        </div>
      </main>
      <Confirm
        open={!!confirming()}
        title={t("tasks.archiveConfirmTitle", { title: confirming()?.title ?? "" })}
        description={t("tasks.archiveConfirmDetail")}
        confirm={t("tasks.archiveConfirm")}
        cancel={t("common.cancel")}
        danger
        onResult={(ok) => {
          const card = confirming()
          setConfirming(undefined)
          if (ok && card) void archiveCards([card]).catch(failed)
        }}
      />
    </div>
  )
}
