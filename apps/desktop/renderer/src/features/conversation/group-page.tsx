import { createEffect, createResource, createSignal, For, on, Show, untrack } from "solid-js"
import type { GroupMember } from "@merakcode/sdk"
import { z } from "zod"
import { t } from "../../i18n"
import { client } from "../../state/client"
import { groupView, loadGroup, localHuman, markGroupRead } from "../../state/groups"
import { Markdown } from "../../ui/markdown"
import { toast } from "../../ui/toast"
import { Frame } from "../shell/frame"
import { Composer } from "./composer"
import { Profiles } from "../settings/profiles"
import { Dialog } from "../../ui/dialog"
import { TaskBoard } from "../group/board"
import { useSearchParams } from "@solidjs/router"
import { GroupInbox } from "../group/inbox"
import { TaskReview } from "../group/review"
import { noticeText } from "../group/notice"

export function GroupConversation(props: { id: string; directory: string }) {
  const [to, setTo] = createSignal<string[]>([])
  const [task, setTask] = createSignal("")
  const [editing, setEditing] = createSignal(false)
  const [savingInitiative, setSavingInitiative] = createSignal(false)
  const [params, setParams] = useSearchParams()
  const tab = () =>
    params.view === "board" || params.view === "inbox" || params.view === "review" ? params.view : "chat"
  const setTab = (view: string) => setParams({ view, task: undefined, notice: undefined })
  const view = () => groupView(props.id)
  const reviewedTask = () =>
    Object.values(view()?.board.columns ?? {})
      .flat()
      .find((card) => card.id === params.task)
  createEffect(() => {
    const id = props.id
    const sequence = view()?.lastSeq ?? 0
    untrack(() => markGroupRead(id, sequence))
  })
  const [sources, { refetch }] = createResource(
    () =>
      view()
        ?.members.map((member) => member.profile ?? member.id)
        .join(","),
    async () => {
      const connection = await client()
      const [profiles, products] = await Promise.all([
        connection.profile.list({ human: localHuman }),
        connection.member.catalog(),
      ])
      return { profiles: profiles ?? [], products: products ?? [] }
    },
  )
  const capabilitiesReady = () => sources.state === "ready"
  const canMessage = (member: GroupMember) => {
    if (!capabilitiesReady()) return false
    const profile = sources()?.profiles.find((profile) => profile.id === member.profile)
    return (
      !!profile &&
      !!sources()?.products.find((product) => product.kind === (profile.product?.kind ?? "builtin"))?.caps.steer
    )
  }
  const capabilityHint = (member: GroupMember) => {
    if (sources.error) return t("group.capabilitiesFailed")
    if (!capabilitiesReady()) return t("group.capabilitiesLoading")
    if (!canMessage(member)) return t("group.newTaskOnly")
  }
  const activity = (member: GroupMember) => {
    const sessions = Object.values(view()?.activity ?? {}).filter(
      (session) => session.member === member.id && session.status === "running",
    )
    const tasks = Object.values(view()?.board.columns ?? {})
      .flat()
      .filter(
        (card) =>
          card.claims?.some((claim) => claim.member === member.id && claim.status === "active") ||
          sessions.some((session) => session.task === card.id),
      )
    return { busy: sessions.length > 0 || tasks.length > 0, tasks }
  }
  createEffect(
    on(
      () => props.id,
      (id) => {
        setTo([])
        setTask("")
        void loadGroup(id).catch((error) =>
          toast({ kind: "error", title: t("error.request", { message: "MRK-6001" }), error }),
        )
      },
    ),
  )
  const messages = () => {
    const events = view()?.events ?? []
    const progress = new Map<string, string>()
    for (const event of events) if (event.type === "task.progress") progress.set(event.payload.claim, event.id)
    return events.flatMap((event) => {
      if (task() && event.scope.task !== task()) return []
      const author = view()?.members.find((member) => member.id === event.actor.id)?.name ?? t("group.leader")
      if (event.type === "human.said") return [{ id: event.id, author, kind: "human", text: event.payload.text }]
      if (event.type === "task.progress" && progress.get(event.payload.claim) === event.id)
        return [{ id: event.id, author, kind: "progress", text: event.payload.summary }]
      if (event.type === "message.completed" && event.payload.role === "assistant")
        return [
          {
            id: event.id,
            author,
            kind: "assistant",
            text: event.payload.parts?.map((part) => part.text ?? "").join("\n") ?? "",
          },
        ]
      if (event.type === "notice.sent" && event.payload.to?.includes(localHuman) && event.payload.text)
        return [{ id: event.id, author, kind: "notice", text: noticeText(event.payload.text) }]
      return []
    })
  }
  return (
    <Frame
      directory={props.directory}
      folder={props.directory}
      title={<span class="title ellipsis">{view()?.group?.name}</span>}
      actions={
        <div class="row" role="tablist" aria-label={t("group.views")}>
          <button class="button ghost sm" role="tab" aria-selected={tab() === "chat"} onClick={() => setTab("chat")}>
            {t("group.chat")}
          </button>
          <button class="button ghost sm" role="tab" aria-selected={tab() === "board"} onClick={() => setTab("board")}>
            {t("task.board")}
          </button>
          <button class="button ghost sm" role="tab" aria-selected={tab() === "inbox"} onClick={() => setTab("inbox")}>
            {t("inbox.title")}
          </button>
        </div>
      }
    >
      <Show
        when={tab() === "chat"}
        fallback={
          <Show when={view()?.group}>
            {(group) => (
              <Show
                when={tab() === "board"}
                fallback={
                  <Show
                    when={tab() === "review"}
                    fallback={
                      <GroupInbox
                        inbox={view()!.inbox}
                        notice={typeof params.notice === "string" ? params.notice : undefined}
                        onTask={(task) => setParams({ view: "review", task, notice: undefined })}
                      />
                    }
                  >
                    <Show when={reviewedTask()}>
                      {(card) => (
                        <TaskReview
                          card={card()}
                          cards={Object.values(view()!.board.columns).flat()}
                          events={view()!.events}
                          members={view()!.members}
                          directory={props.directory}
                          onBack={() => setTab("board")}
                        />
                      )}
                    </Show>
                  </Show>
                }
              >
                <TaskBoard
                  group={group()}
                  board={view()!.board}
                  members={view()!.members}
                  task={typeof params.task === "string" ? params.task : undefined}
                  onReview={(task) => setParams({ view: "review", task, notice: undefined })}
                />
              </Show>
            )}
          </Show>
        }
      >
        <div class="chat-area">
          <div class="chat-main">
            <div class="messages scroll" role="log" aria-label={t("group.chat")}>
              <For each={messages()}>
                {(message) => (
                  <article class="group-message" data-group-message={message.kind}>
                    <strong>{message.author}</strong>
                    <Markdown text={message.text} />
                  </article>
                )}
              </For>
            </div>
            <div class="dock">
              <div class="dock-inner">
                <label class="group-discussion">
                  <span>{t("group.discussion")}</span>
                  <select
                    class="input"
                    aria-label={t("group.discussion")}
                    value={task()}
                    onChange={(event) => {
                      setTask(event.currentTarget.value)
                      setTo([])
                    }}
                  >
                    <option value="">{t("group.chat")}</option>
                    <For each={Object.values(view()?.board.columns ?? {}).flat()}>
                      {(card) => <option value={card.id}>{card.title}</option>}
                    </For>
                  </select>
                </label>
                <Show when={to().length}>
                  <p class="subtle">
                    @{view()?.members.find((member) => member.id === to()[0])?.name}
                    <button class="button ghost sm" onClick={() => setTo([])}>
                      {t("common.cancel")}
                    </button>
                  </p>
                </Show>
                <Composer
                  group
                  directory={props.directory}
                  sessionID={`group:${props.id}:${task()}`}
                  busy={false}
                  disabled={!view()?.group}
                  placeholder={t("group.placeholder")}
                  onSubmit={async ({ text }) => {
                    const members = [...(view()?.members ?? [])].sort((a, b) => b.name.length - a.name.length)
                    const names = members.map((member) => member.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
                    const matches = names.length
                      ? text.matchAll(new RegExp(`(?:^|\\s)@(${names.join("|")})(?=$|[\\s,.:;!?，。！？：；])`, "gu"))
                      : []
                    const recipients = new Set(to())
                    for (const match of matches) {
                      const member = members.find((member) => member.name === match[1])
                      if (member) recipients.add(member.id)
                    }
                    await (
                      await client()
                    ).group.say({
                      group: props.id,
                      task: task() || undefined,
                      human: localHuman,
                      text,
                      to: [...recipients],
                    })
                  }}
                />
              </div>
            </div>
          </div>
          <aside class="member-column" aria-label={t("group.column")}>
            <Show
              when={view()?.members.some(
                (member) => member.id === localHuman && (member.role === "owner" || member.role === "admin"),
              )}
            >
              <label>
                <span>{t("group.initiative")}</span>
                <select
                  class="input"
                  aria-label={t("group.initiative")}
                  value={view()?.group?.settings?.initiative || "normal"}
                  disabled={savingInitiative()}
                  onChange={async (event) => {
                    const selected = event.currentTarget
                    const group = view()?.group
                    if (!group) return
                    setSavingInitiative(true)
                    try {
                      const initiative = z.enum(["passive", "normal", "eager"]).parse(selected.value)
                      await (
                        await client()
                      ).group.update({
                        group: group.id,
                        human: localHuman,
                        settings: { ...group.settings, initiative },
                      })
                    } catch (error) {
                      selected.value = group.settings?.initiative || "normal"
                      toast({ kind: "error", title: t("error.request", { message: "MRK-6001" }), error })
                    } finally {
                      setSavingInitiative(false)
                    }
                  }}
                >
                  <option value="passive">{t("group.initiative.passive")}</option>
                  <option value="normal">{t("group.initiative.normal")}</option>
                  <option value="eager">{t("group.initiative.eager")}</option>
                </select>
              </label>
            </Show>
            <h2>{t("group.column.title")}</h2>
            <Show when={sources.error}>
              <button class="button secondary sm" onClick={() => void refetch()}>
                {t("error.retry")}
              </button>
            </Show>
            <button class="button secondary sm" onClick={() => setEditing(true)}>
              {t("group.addMember")}
            </button>
            <For each={view()?.members.filter((member) => member.kind === "agent")}>
              {(member) => (
                <div
                  class="member-seat"
                  role="group"
                  aria-label={t("group.member", { name: member.name })}
                  data-state={activity(member).busy ? "busy" : "idle"}
                >
                  <strong>{member.name}</strong>
                  <span class="subtle">{t(activity(member).busy ? "group.busy" : "group.idle")}</span>
                  <For each={activity(member).tasks}>
                    {(card) => (
                      <button
                        class="button ghost sm"
                        onClick={() => {
                          setTask(card.id)
                          setTo([])
                        }}
                      >
                        {card.title}
                      </button>
                    )}
                  </For>
                  <button
                    class="button secondary sm"
                    aria-label={t("group.messageMember", { name: member.name })}
                    disabled={!canMessage(member)}
                    title={capabilityHint(member)}
                    onClick={() => setTo([member.id])}
                  >
                    {t("group.messageMember", { name: member.name })}
                  </button>
                  <Show when={capabilityHint(member)}>{(hint) => <p class="subtle">{hint()}</p>}</Show>
                </div>
              )}
            </For>
          </aside>
          <Dialog
            open={editing()}
            onOpenChange={setEditing}
            title={t("group.addMember")}
            footer={
              <button class="button secondary" onClick={() => setEditing(false)}>
                {t("common.close")}
              </button>
            }
          >
            <div class="dialog-body">
              <Show when={editing()}>
                <Profiles group={props.id} />
              </Show>
            </div>
          </Dialog>
        </div>
      </Show>
    </Frame>
  )
}
