import type { Board, GroupGroup, GroupMember, TaskStatus } from "@merakcode/sdk"
import { createEffect, createSignal, For, on, Show } from "solid-js"
import { t, type Key } from "../../i18n"
import { Dialog } from "../../ui/dialog"
import { Markdown } from "../../ui/markdown"
import { Report } from "./report"
import { CreateTask } from "./create-task"
import { client } from "../../state/client"
import { localHuman } from "../../state/groups"
import { toast } from "../../ui/toast"
import { ClaimProcess } from "./process"
import { conflictFiles } from "./conflicts"

const statusKeys: Record<TaskStatus, Key> = {
  draft: "task.status.draft",
  open: "task.status.open",
  queued: "task.status.queued",
  running: "task.status.running",
  review: "task.status.review",
  blocked: "task.status.blocked",
  done: "task.status.done",
  failed: "task.status.failed",
  cancelled: "task.status.cancelled",
}
const phaseKeys: Record<string, Key> = {
  planning: "task.phase.planning",
  doing: "task.phase.doing",
  integrating: "task.phase.integrating",
  review: "task.status.review",
  done: "task.status.done",
  stalled: "task.status.blocked",
  cancelled: "task.status.cancelled",
}

export function TaskBoard(props: {
  group: GroupGroup
  board: Board
  members: GroupMember[]
  task?: string
  onReview?: (id: string) => void
}) {
  const [selected, setSelected] = createSignal("")
  const [creating, setCreating] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [assignee, setAssignee] = createSignal("")
  const [scope, setScope] = createSignal("")
  createEffect(
    on(
      () => props.task,
      (id) => {
        if (id) setSelected(id)
      },
    ),
  )
  createEffect(
    on(selected, () => {
      setAssignee("")
      setScope("")
    }),
  )
  const card = () =>
    Object.values(props.board.columns)
      .flat()
      .find((card) => card.id === selected())
  const memberName = (id: string) => props.members.find((member) => member.id === id)?.name ?? id
  const collaborators = () => card()?.claims?.some((claim) => claim.status !== "abandoned") ?? false
  const assign = async () => {
    const task = card()
    if (!task || !assignee() || busy()) return
    setBusy(true)
    try {
      await (
        await client()
      ).task.assign({
        task: task.id,
        human: localHuman,
        member: assignee(),
        role: collaborators() ? "collaborator" : "owner",
        scope: scope()
          .split("\n")
          .map((area) => area.trim())
          .filter(Boolean),
      })
      setAssignee("")
      setScope("")
    } catch (error) {
      toast({ kind: "error", title: t("error.request", { message: "MRK-6001" }), error })
    } finally {
      setBusy(false)
    }
  }
  const cancel = async () => {
    const task = card()
    if (!task || busy()) return
    setBusy(true)
    try {
      await (await client()).task.cancel({ task: task.id, human: localHuman })
    } catch (error) {
      toast({ kind: "error", title: t("error.request", { message: "MRK-6001" }), error })
    } finally {
      setBusy(false)
    }
  }
  return (
    <section class="task-board scroll" aria-label={t("task.board")}>
      <button class="button primary" onClick={() => setCreating(true)}>
        {t("task.create")}
      </button>
      <Dialog open={creating()} title={t("task.create")} onOpenChange={setCreating}>
        <Show when={creating()}>
          <CreateTask group={props.group} members={props.members} onCreated={() => setCreating(false)} />
        </Show>
      </Dialog>
      <Show when={props.board.goals.length}>
        <div class="task-goals" role="region" aria-label={t("task.goals")}>
          <h2>{t("task.goals")}</h2>
          <For each={props.board.goals}>
            {(goal) => (
              <button class="button secondary" onClick={() => setSelected(goal.id)}>
                {goal.title} · {phaseKeys[goal.phase ?? ""] ? t(phaseKeys[goal.phase!]!) : goal.phase}
              </button>
            )}
          </For>
        </div>
      </Show>
      <div class="task-columns">
        <For each={Object.keys(props.board.columns) as TaskStatus[]}>
          {(status) => (
            <section class="task-column" aria-label={t("task.column", { status: t(statusKeys[status]) })}>
              <h3>
                {t(statusKeys[status])} <span class="count">{props.board.columns[status].length}</span>
              </h3>
              <For each={props.board.columns[status]}>
                {(task) => (
                  <button class="task-card" onClick={() => setSelected(task.id)}>
                    <strong>{task.title}</strong>
                    <Show when={conflictFiles(task, Object.values(props.board.columns).flat()).length}>
                      <span class="badge danger">{t("task.review.conflict")}</span>
                    </Show>
                    <For each={task.claims}>
                      {(claim) => (
                        <span class="subtle">
                          {memberName(claim.member)}
                          <Show when={task.queue?.[claim.id]}>
                            {" "}
                            · {t("task.queue", { position: task.queue![claim.id]! })}
                          </Show>
                        </span>
                      )}
                    </For>
                    <For each={Object.values(task.progress ?? {})}>{(summary) => <span>{summary}</span>}</For>
                  </button>
                )}
              </For>
            </section>
          )}
        </For>
      </div>
      <Dialog
        open={!!card()}
        title={card()?.title ?? ""}
        onOpenChange={(open) => !open && setSelected("")}
        footer={
          <>
            <Show when={card() && props.onReview}>
              <button
                class="button primary"
                onClick={() => {
                  const id = selected()
                  setSelected("")
                  props.onReview?.(id)
                }}
              >
                {t("task.review.open")}
              </button>
            </Show>
            <Show when={card() && !["done", "cancelled"].includes(card()!.status)}>
              <button class="button secondary danger" disabled={busy()} onClick={() => void cancel()}>
                {t("task.cancel")}
              </button>
            </Show>
            <button class="button secondary" onClick={() => setSelected("")}>
              {t("common.close")}
            </button>
          </>
        }
      >
        <Show when={card()}>
          {(task) => (
            <div class="dialog-body task-detail">
              <Show when={["open", "queued", "running"].includes(task().status)}>
                <div class="task-assign">
                  <label>
                    {t("task.assign")}
                    <select
                      class="input"
                      aria-label={t("task.assign")}
                      value={assignee()}
                      disabled={busy()}
                      onChange={(event) => setAssignee(event.currentTarget.value)}
                    >
                      <option value="">{t("task.chooseMember")}</option>
                      <For
                        each={props.members.filter(
                          (member) =>
                            member.agentRole === "worker" &&
                            !task().claims?.some((claim) => claim.member === member.id && claim.status !== "abandoned"),
                        )}
                      >
                        {(member) => <option value={member.id}>{member.name}</option>}
                      </For>
                    </select>
                  </label>
                  <Show when={collaborators()}>
                    <label>
                      {t("task.scope")}
                      <textarea
                        class="input"
                        aria-label={t("task.scope")}
                        value={scope()}
                        disabled={busy()}
                        onInput={(event) => setScope(event.currentTarget.value)}
                      />
                    </label>
                  </Show>
                  <button class="button primary" disabled={busy() || !assignee()} onClick={() => void assign()}>
                    {t("task.assign")}
                  </button>
                </div>
              </Show>
              <Markdown text={task().description} />
              <Show when={task().acceptance?.length}>
                <h3>{t("task.acceptance")}</h3>
                <ul>
                  <For each={task().acceptance}>{(criterion) => <li>{criterion}</li>}</For>
                </ul>
              </Show>
              <For each={task().claims}>
                {(claim) => (
                  <section aria-label={memberName(claim.member)}>
                    <h3>{memberName(claim.member)}</h3>
                    <Show when={claim.report}>{(report) => <Report report={report()} />}</Show>
                    <Show when={claim.session}>
                      {(session) => <ClaimProcess session={session()} directory={props.group.project.directory} />}
                    </Show>
                  </section>
                )}
              </For>
            </div>
          )}
        </Show>
      </Dialog>
    </section>
  )
}
