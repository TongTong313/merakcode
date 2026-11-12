import ArrowLeft from "lucide-solid/icons/arrow-left"
import { useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import type { TaskCard } from "@merakcode/sdk"
import { t } from "../../i18n"
import { groupPath, taskPath } from "../../lib/route"
import { client } from "../../state/client"
import { groups, groupView } from "../../state/groups"
import { claimOrigin, loadTasks, taskOf, tasks, tasksLoaded } from "../../state/tasks"
import { Avatar } from "../../ui/avatar"
import { Markdown } from "../../ui/markdown"
import { Select } from "../../ui/select"
import { toast } from "../../ui/toast"
import { GroupCreate } from "../conversation/group-create"
import { ClaimProcess } from "../group/process"
import { Report } from "../group/report"
import { TaskReview } from "../group/review"
import { Sidebar } from "../shell/sidebar"
import { ChooseGroup } from "./choose"

/** One task: where it belongs, what it asks for, who works on it and what they reported. */
export function TaskPage() {
  const params = useParams()
  const navigate = useNavigate()
  const [creating, setCreating] = createSignal(false)
  const [choosing, setChoosing] = createSignal(false)
  const [search, setSearch] = useSearchParams()
  const reviewing = () => search.review === "1"
  const setReviewing = (open: boolean) => setSearch({ review: open ? "1" : undefined }, { replace: true })
  onMount(() => {
    if (!tasksLoaded()) void loadTasks()
  })
  const card = () => taskOf(params.id ?? "")
  const group = () => groups().find((item) => item.id === card()?.group)
  const view = () => groupView(card()?.group ?? "")
  const members = () => view()?.members ?? []
  const name = (id: string) => members().find((member) => member.id === id)?.name ?? id
  const leader = () => (group() ? name(group()!.leader) : undefined)
  const subtasks = createMemo(() => tasks().filter((item) => item.parent === card()?.id))
  const boardCard = () =>
    Object.values(view()?.board.columns ?? {})
      .flat()
      .find((item) => item.id === card()?.id)
  const [assignee, setAssignee] = createSignal("")
  const [scope, setScope] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const collaborators = () => card()?.claims?.some((claim) => claim.status !== "abandoned") ?? false
  const candidates = () =>
    members().filter(
      (member) =>
        member.agentRole === "worker" &&
        !card()?.claims?.some((claim) => claim.member === member.id && claim.status !== "abandoned"),
    )
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await action()
    } catch (error) {
      toast({ kind: "error", title: t("error.request", { message: "MRK-6001" }), error })
    } finally {
      setBusy(false)
    }
  }
  const assign = () =>
    run(async () => {
      await (
        await client()
      ).task.assign({
        task: card()!.id,
        member: assignee(),
        role: collaborators() ? "collaborator" : "owner",
        scope: scope()
          .split("\n")
          .map((area) => area.trim())
          .filter(Boolean),
      })
      setAssignee("")
      setScope("")
    })
  const cancel = () => run(async () => void (await (await client()).task.cancel({ task: card()!.id })))
  const goToGroup = (group: { project: { directory: string }; id: string }) =>
    navigate(groupPath(group.project.directory, group.id))
  return (
    <div class="app">
      <Sidebar task={params.id} />
      <main class="main">
        <div class="topbar drag">
          <button class="button ghost sm no-drag" onClick={() => navigate("/tasks")}>
            <ArrowLeft class="icon icon-xs" />
            {t("tasks.back")}
          </button>
          <span class="title ellipsis">{card()?.title}</span>
        </div>
        <div class="settings-body scroll">
          <Show
            when={card()}
            fallback={<p class="subtle task-page">{tasksLoaded() ? t("task.notFound") : t("inbox.loading")}</p>}
          >
            {(task) => (
              <div class="task-page">
                <div class="task-head">
                  <h1>{task().title}</h1>
                  <span class="badge neutral">{t(`task.status.${task().status as "open"}`)}</span>
                </div>
                <dl class="task-facts">
                  <dt>{t("task.workspace")}</dt>
                  <dd class="mono ellipsis" title={task().project}>
                    {task().project}
                  </dd>
                  <Show when={group()}>
                    {(owner) => (
                      <>
                        <dt>{t("task.group")}</dt>
                        <dd>
                          <button class="button ghost sm" data-task-group onClick={() => goToGroup(owner())}>
                            {owner().name}
                          </button>
                        </dd>
                        <dt>{t("task.leader")}</dt>
                        <dd>{leader()}</dd>
                      </>
                    )}
                  </Show>
                </dl>
                <Show when={!task().group}>
                  <section class="card task-start" aria-label={t("task.needsGroup")}>
                    <p>{t("task.needsGroup")}</p>
                    <div class="row">
                      <button class="button primary" onClick={() => setCreating(true)}>
                        {t("task.newGroup")}
                      </button>
                      <button class="button secondary" onClick={() => setChoosing(true)}>
                        {t("task.chooseGroup")}
                      </button>
                    </div>
                  </section>
                </Show>
                <Show when={task().group && ["open", "queued", "running"].includes(task().status)}>
                  <section class="task-assign" aria-label={t("task.assign")}>
                    <div class="row">
                      <Select
                        class="chip outlined"
                        label={t("task.assign")}
                        placeholder={t("task.chooseMember")}
                        value={assignee() || undefined}
                        disabled={busy()}
                        options={candidates().map((member) => ({ value: member.id, label: member.name }))}
                        onChange={setAssignee}
                      />
                      <button class="button primary sm" disabled={busy() || !assignee()} onClick={() => void assign()}>
                        {t("task.assign")}
                      </button>
                    </div>
                    <Show when={collaborators()}>
                      <label class="field">
                        <span>{t("task.scope")}</span>
                        <textarea
                          class="input"
                          aria-label={t("task.scope")}
                          value={scope()}
                          disabled={busy()}
                          onInput={(event) => setScope(event.currentTarget.value)}
                        />
                      </label>
                    </Show>
                  </section>
                </Show>
                <Show when={!["done", "failed", "cancelled"].includes(task().status)}>
                  <div class="row">
                    <button class="button secondary danger sm" disabled={busy()} onClick={() => void cancel()}>
                      {t("task.cancel")}
                    </button>
                  </div>
                </Show>
                <Show when={task().description}>
                  <Markdown text={task().description} />
                </Show>
                <Show when={task().acceptance?.length}>
                  <h2>{t("task.acceptance")}</h2>
                  <ul>
                    <For each={task().acceptance}>{(criterion) => <li>{criterion}</li>}</For>
                  </ul>
                </Show>
                <Show when={subtasks().length}>
                  <h2>{t("task.subtasks")}</h2>
                  <For each={subtasks()}>
                    {(child) => (
                      <button class="button ghost sm" onClick={() => navigate(taskPath(child.id))}>
                        {child.title} · {t(`task.status.${child.status as "open"}`)}
                      </button>
                    )}
                  </For>
                </Show>
                <h2>{t("task.claims")}</h2>
                <Show when={task().claims?.length} fallback={<p class="subtle">{t("task.noClaims")}</p>}>
                  <For each={task().claims}>
                    {(claim) => (
                      <section class="task-claim" data-claim={claim.id} aria-label={name(claim.member)}>
                        <div class="row">
                          <Avatar id={claim.member} name={name(claim.member)} />
                          <strong>
                            {claimOrigin(claim.id) === "self"
                              ? t("task.claimSelf", { name: name(claim.member) })
                              : t("task.claimGiven", { name: name(claim.member) })}
                          </strong>
                          <span class="badge neutral">{claim.status}</span>
                        </div>
                        <Show when={boardCard()?.progress?.[claim.id]}>
                          {(line) => <p class="claim-progress subtle">{line()}</p>}
                        </Show>
                        <Show when={claim.report}>{(report) => <Report report={report()} />}</Show>
                        <Show when={claim.session && group()?.project.directory}>
                          {(directory) => <ClaimProcess session={claim.session!} directory={directory()} />}
                        </Show>
                      </section>
                    )}
                  </For>
                </Show>
                <Show when={task().group && boardCard() && (task().status === "review" || task().phase === "review")}>
                  <button class="button primary" onClick={() => setReviewing(!reviewing())}>
                    {t("task.review.open")}
                  </button>
                </Show>
                <Show when={reviewing() && boardCard() && group()}>
                  <TaskReview
                    card={boardCard()!}
                    cards={Object.values(view()!.board.columns).flat()}
                    events={view()!.events}
                    members={members()}
                    directory={group()!.project.directory}
                    onBack={() => setReviewing(false)}
                  />
                </Show>
              </div>
            )}
          </Show>
        </div>
      </main>
      <Show when={card() && !card()!.group}>
        <GroupCreate
          directory={card()!.project}
          task={card() as TaskCard}
          open={creating()}
          onClose={() => setCreating(false)}
          onCreated={goToGroup}
        />
        <ChooseGroup
          task={card() as TaskCard}
          open={choosing()}
          onClose={() => setChoosing(false)}
          onBound={() => {}}
        />
      </Show>
    </div>
  )
}
