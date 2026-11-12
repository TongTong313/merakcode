import ChevronRight from "lucide-solid/icons/chevron-right"
import { useNavigate } from "@solidjs/router"
import { createEffect, createMemo, For, Match, Show, Switch } from "solid-js"
import type { GroupMember, TaskCard } from "@merakcode/sdk"
import { t } from "../../i18n"
import { taskPath } from "../../lib/route"
import { groupView } from "../../state/groups"
import { ensureSession, state } from "../../state/store"
import { Avatar } from "../../ui/avatar"
import { Markdown } from "../../ui/markdown"
import { toast } from "../../ui/toast"
import { Parts } from "../conversation/messages"
import { chatItems, sayText, type ChatItem } from "./timeline"

const names = (members: readonly GroupMember[], ids: readonly string[]) =>
  ids.map((id) => members.find((member) => member.id === id)?.name ?? id).join("、")

/** The status of a message the person sent: delivered once the group has it, processing once it has been read. */
function Receipt(props: { item: Extract<ChatItem, { kind: "human" }>; members: readonly GroupMember[] }) {
  const text = () => {
    if (props.item.status === "processing") return t("group.receipt.processing")
    if (props.item.status !== "delivered") return ""
    return props.item.deliveredTo.length
      ? t("group.receipt.deliveredTo", { names: names(props.members, props.item.deliveredTo) })
      : t("group.receipt.delivered")
  }
  return (
    <Show when={text()}>
      <span class="receipt subtle" data-receipt={props.item.status}>
        {text()}
      </span>
    </Show>
  )
}

function TaskLine(props: { task?: TaskCard; id: string }) {
  const navigate = useNavigate()
  return (
    <button class="group-task-card" data-group-task={props.id} onClick={() => navigate(taskPath(props.id))}>
      <strong class="ellipsis">{props.task?.title ?? props.id}</strong>
      <Show when={props.task}>
        {(card) => <span class="badge neutral">{t(`task.status.${card().status as "open"}`)}</span>}
      </Show>
    </button>
  )
}

/**
 * The messages of a group: what people said, the Leader's replies as they are written, the Leader's tool calls with
 * the conversation's tool cards, the tasks it created and how each task is going.
 */
export function GroupChat(props: { id: string; directory: string }) {
  const navigate = useNavigate()
  const view = () => groupView(props.id)
  const members = () => view()?.members ?? []
  const leaderSession = () => view()?.leader?.session
  createEffect(() => {
    const id = leaderSession()
    if (id) void ensureSession(id).catch((error) => toast({ kind: "error", title: t("conversation.notFound"), error }))
  })
  const cards = createMemo(() => Object.values(view()?.board.columns ?? {}).flat())
  const card = (id: string) => cards().find((item) => item.id === id)
  const claimMember = (claim: string) =>
    cards()
      .flatMap((item) => item.claims ?? [])
      .find((item) => item.id === claim)?.member
  const items = createMemo(() => chatItems(view()?.events ?? [], { claimMember }))
  const author = (id: string) => members().find((member) => member.id === id)?.name ?? t("group.unknownMember")
  const live = () => (leaderSession() ? state.views[leaderSession()!]?.live : undefined)
  const running = () => !!leaderSession() && state.views[leaderSession()!]?.state.status === "running"
  const liveSay = () => sayText(live()?.parts.findLast((part) => part.toolCall?.name === "say")?.toolCall?.input)
  const liveWork = () => (live()?.parts ?? []).filter((part) => part.toolCall?.name !== "say")
  const leaderName = () => author(view()?.leader?.member ?? view()?.group?.leader ?? "")
  let scroll!: HTMLDivElement
  let pinned = true
  createEffect(() => {
    items().length
    live()
    queueMicrotask(() => {
      if (scroll && pinned) scroll.scrollTop = scroll.scrollHeight
    })
  })
  return (
    <div
      class="messages scroll"
      role="log"
      aria-label={t("group.chat")}
      ref={scroll}
      onScroll={() => {
        pinned = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 48
      }}
    >
      <div class="messages-inner">
        <Show when={!items().length && !live()}>
          <div class="group-intro">
            <h2>{view()?.group?.name}</h2>
            <p class="muted">{t("group.empty")}</p>
          </div>
        </Show>
        <For each={items()}>
          {(item) => (
            <Switch>
              <Match when={item.kind === "human" && item}>
                {(human) => (
                  <article class="user-turn" data-group-message="human" aria-label={t("conversation.you")}>
                    <div class="user-message selectable">
                      <Markdown text={human().text} />
                    </div>
                    <Receipt item={human()} members={members()} />
                  </article>
                )}
              </Match>
              <Match when={item.kind === "reply" && item}>
                {(reply) => (
                  <article class="assistant-message selectable group-reply" data-group-message="assistant">
                    <div class="group-author">
                      <Avatar id={reply().authorID} name={author(reply().authorID)} />
                      <strong>{author(reply().authorID)}</strong>
                    </div>
                    <Markdown text={reply().text} />
                  </article>
                )}
              </Match>
              <Match when={item.kind === "work" && item}>
                {(work) => (
                  <details class="turn-work group-work" data-group-message="work">
                    <summary class="step-head turn-summary">
                      <ChevronRight class="icon icon-sm chevron" />
                      {t("group.work", { name: author(work().authorID) })}
                    </summary>
                    <Parts parts={work().parts} sessionID={work().session} directory={props.directory} />
                  </details>
                )}
              </Match>
              <Match when={item.kind === "task" && item}>
                {(created) => <TaskLine id={created().task} task={card(created().task)} />}
              </Match>
              <Match when={item.kind === "progress" && item}>
                {(progress) => (
                  <div class="group-progress" data-group-message="progress">
                    <Avatar id={progress().authorID} name={author(progress().authorID)} />
                    <span class="subtle">{author(progress().authorID)}</span>
                    <button class="button ghost sm" onClick={() => navigate(taskPath(progress().task))}>
                      {progress().text}
                    </button>
                  </div>
                )}
              </Match>
            </Switch>
          )}
        </For>
        <Show when={liveWork().length && leaderSession()}>
          <section class="turn assistant-turn" aria-live="polite" data-group-message="live-work">
            <Parts parts={liveWork()} sessionID={leaderSession()!} directory={props.directory} />
          </section>
        </Show>
        <Show when={liveSay()}>
          <article class="assistant-message selectable group-reply" data-group-message="streaming" aria-live="polite">
            <div class="group-author">
              <Avatar id={view()?.leader?.member ?? ""} name={leaderName()} />
              <strong>{leaderName()}</strong>
            </div>
            <Markdown text={liveSay()} />
          </article>
        </Show>
        <Show when={running()}>
          <div class="subtle" role="status">
            {t("group.leaderWorking", { name: leaderName() })}
          </div>
        </Show>
      </div>
    </div>
  )
}
