import type { AssistantMessage, FilePart, Part, ReasoningPart, UserMessage } from "@merakcode/sdk/client"
import Brain from "lucide-solid/icons/brain"
import ChevronRight from "lucide-solid/icons/chevron-right"
import CircleAlert from "lucide-solid/icons/circle-alert"
import FileDiff from "lucide-solid/icons/file-diff"
import Paperclip from "lucide-solid/icons/paperclip"
import Copy from "lucide-solid/icons/copy"
import Pencil from "lucide-solid/icons/pencil"
import RotateCcw from "lucide-solid/icons/rotate-ccw"
import RotateCw from "lucide-solid/icons/rotate-cw"
import Undo2 from "lucide-solid/icons/undo-2"
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js"
import { t } from "../../i18n"
import { bridge } from "../../lib/bridge"
import { relative } from "../../lib/route"
import { busy, messagesOf, partsOf, state } from "../../state/store"
import { Markdown } from "../../ui/markdown"
import { copyDetails, toast } from "../../ui/toast"
import { summary } from "../../state/error"
import { fill } from "./composer"
import { retry, revertTo, submissionOf } from "./send"
import { Tool, Explore } from "./tools"
import { blocks, changes, turns, type Turn } from "./turns"

function Reasoning(props: { part: ReasoningPart; done: boolean }) {
  const [open, setOpen] = createSignal(false)
  const seconds = () => {
    const end = props.part.time.end
    return end ? Math.max(1, Math.round((end - props.part.time.start) / 1000)) : undefined
  }
  return (
    <div class="step reasoning">
      <button class="step-head" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <ChevronRight class="icon icon-sm chevron" />
        <Brain class="icon icon-sm subtle" />
        <span class="step-title">
          {props.done && seconds() ? t("conversation.thought", { seconds: seconds()! }) : t("conversation.thinking")}
        </span>
      </button>
      <Show when={open()}>
        <div class="step-detail reasoning-text">
          <Markdown text={props.part.text} />
        </div>
      </Show>
    </div>
  )
}

function Attachment(props: { part: FilePart }) {
  return (
    <span class="attachment" title={props.part.filename ?? props.part.url}>
      <Paperclip class="icon icon-xs" />
      <span class="ellipsis">{props.part.filename ?? props.part.url.split("/").pop()}</span>
    </span>
  )
}

const failed = (error: Error) =>
  toast({ kind: "error", title: t("error.request", { message: error.message }), error: error })

const copy = (text: string) =>
  (bridge ? bridge.writeClipboardText(text) : navigator.clipboard.writeText(text)).then(
    () => toast({ kind: "success", title: t("common.copied") }),
    failed,
  )

/**
 * A message the user sent. Hovering shows Edit (revert to before it and put its text back in the composer) and Revert
 * (hide it and later messages, restore files). The context compaction message renders as a divider.
 */
function UserBubble(props: { message: UserMessage; sessionID: string; directory: string }) {
  const parts = () => partsOf(props.message.id)
  const compaction = () => parts().some((part) => part.type === "compaction")
  const text = () =>
    parts()
      .filter((part) => part.type === "text" && !part.synthetic)
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n")
  const files = () => parts().filter((part): part is FilePart => part.type === "file")
  const revert = () => revertTo(props.sessionID, props.directory, props.message.id).catch(failed)
  const edit = async () => {
    const draft = submissionOf(props.message).text
    await revertTo(props.sessionID, props.directory, props.message.id)
    fill(props.sessionID, draft)
  }
  return (
    <Show when={!compaction()} fallback={<div class="divider-label subtle">{t("conversation.compacted")}</div>}>
      <article class="user-turn" aria-label={t("conversation.you")}>
        <div class="message-actions">
          <button
            class="icon-button sm"
            aria-label={t("conversation.edit")}
            title={t("conversation.edit")}
            onClick={() => void edit().catch(failed)}
          >
            <Pencil class="icon icon-xs" />
          </button>
          <button
            class="icon-button sm"
            aria-label={t("conversation.revert")}
            title={t("conversation.revertHint")}
            onClick={() => void revert()}
          >
            <Undo2 class="icon icon-xs" />
          </button>
        </div>
        <div class="user-message selectable">
          <Show when={files().length}>
            <div class="attachments">
              <For each={files()}>{(part) => <Attachment part={part} />}</For>
            </div>
          </Show>
          <div class="user-text">{text()}</div>
        </div>
      </article>
    </Show>
  )
}

/** Actions after a turn's replies: copy the answer, and retry on the last turn */
function TurnActions(props: { turn: Turn; last: boolean; sessionID: string; directory: string }) {
  const text = () =>
    props.turn.replies
      .flatMap((message) => partsOf(message.id))
      .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text.trim()] : []))
      .filter(Boolean)
      .join("\n\n")
  return (
    <div class="turn-actions">
      <Show when={text()}>
        <button
          class="icon-button sm"
          aria-label={t("common.copy")}
          title={t("common.copy")}
          onClick={() => void copy(text())}
        >
          <Copy class="icon icon-xs" />
        </button>
      </Show>
      <Show when={props.last}>
        <button
          class="icon-button sm"
          aria-label={t("conversation.retryTurn")}
          title={t("conversation.retryTurn")}
          onClick={() => void retry(props.sessionID, props.directory, props.turn.user).catch(failed)}
        >
          <RotateCcw class="icon icon-xs" />
        </button>
      </Show>
    </div>
  )
}

function ErrorCard(props: { message: AssistantMessage }) {
  const error = () => props.message.error
  const text = () => {
    const value = error() as { name?: string; data?: { message?: string } } | undefined
    return value?.data?.message ?? value?.name ?? ""
  }
  return (
    <Show when={error() && error()!.name !== "MessageAbortedError"}>
      <div class="error-card selectable" role="alert">
        <CircleAlert class="icon icon-sm" />
        <div class="error-text">
          <div>{text()}</div>
          <Show when={summary(error())}>{(line) => <div class="mono subtle">{line()}</div>}</Show>
        </div>
        <Show when={summary(error())}>
          <button
            class="icon-button sm"
            aria-label={t("error.copyDetails")}
            title={t("error.copyDetails")}
            onClick={() => void copyDetails(error())}
          >
            <Copy class="icon icon-sm" />
          </button>
        </Show>
      </div>
    </Show>
  )
}

/** Files the agent changed in this turn; "Review" opens the review for this turn */
function Changes(props: { turn: Turn; directory: string; onReview: (messageID: string) => void }) {
  const diffs = createMemo(() => changes(props.turn.replies.flatMap((message) => partsOf(message.id))))
  const totals = () =>
    diffs().reduce((sum, diff) => ({ add: sum.add + diff.additions, del: sum.del + diff.deletions }), {
      add: 0,
      del: 0,
    })
  return (
    <Show when={diffs().length}>
      <div class="changes-card">
        <div class="changes-head">
          <FileDiff class="icon icon-sm" />
          <span class="title">{t("conversation.changes")}</span>
          <span class="muted">{t("conversation.changesSummary", { files: diffs().length })}</span>
          <span class="add">+{totals().add}</span>
          <span class="del">−{totals().del}</span>
          <span class="spacer" />
          <button class="button secondary sm" onClick={() => props.onReview(props.turn.user.id)}>
            {t("conversation.review")}
          </button>
        </div>
        <For each={diffs().slice(0, 6)}>
          {(diff) => (
            <div class="change-file">
              <span class="path mono ellipsis">{relative(props.directory, diff.file)}</span>
              <span class="spacer" />
              <span class="add">+{diff.additions}</span>
              <span class="del">−{diff.deletions}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

function Reply(props: {
  message: AssistantMessage
  last: boolean
  sessionID: string
  directory: string
  onReviewFile: (file: string) => void
}) {
  const parts = () => partsOf(props.message.id)
  const list = createMemo(() => blocks(parts()))
  const done = (index: number) => !props.last || !busy(props.sessionID) || index < list().length - 1
  const [open, setOpen] = createSignal(false)
  // Summary written during context compaction, collapsed by default
  const summary = () =>
    parts()
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
  return (
    <Show
      when={!props.message.summary}
      fallback={
        <div class="step">
          <button class="step-head" aria-expanded={open()} onClick={() => setOpen(!open())}>
            <ChevronRight class="icon icon-sm chevron" />
            <span class="step-title">{t("conversation.summary")}</span>
          </button>
          <Show when={open()}>
            <div class="step-detail reasoning-text">
              <Markdown text={summary()} />
            </div>
          </Show>
        </div>
      }
    >
      <For each={list()}>
        {(block, index) =>
          block.kind === "explore" ? (
            <Explore parts={block.parts} directory={props.directory} />
          ) : (
            <PartView
              part={block.part}
              done={done(index())}
              directory={props.directory}
              onReviewFile={props.onReviewFile}
            />
          )
        }
      </For>
      <ErrorCard message={props.message} />
    </Show>
  )
}

function PartView(props: { part: Part; done: boolean; directory: string; onReviewFile: (file: string) => void }) {
  return (
    <Switch>
      <Match when={props.part.type === "text" && props.part}>
        {(part) => (
          <div class="assistant">
            <Markdown text={part().text} />
          </div>
        )}
      </Match>
      <Match when={props.part.type === "reasoning" && props.part}>
        {(part) => <Reasoning part={part()} done={props.done} />}
      </Match>
      <Match when={props.part.type === "tool" && props.part}>
        {(part) => <Tool part={part()} directory={props.directory} onReview={props.onReviewFile} />}
      </Match>
      <Match when={props.part.type === "file" && props.part}>{(part) => <Attachment part={part()} />}</Match>
    </Switch>
  )
}

/** A conversation's messages, shown by turn; follows new content while scrolled to the bottom */
export function Messages(props: {
  sessionID: string
  directory: string
  onReviewTurn: (messageID: string) => void
  onReviewFile: (file: string) => void
}) {
  let scroller!: HTMLDivElement
  let content!: HTMLDivElement
  const grouped = createMemo(() => turns(messagesOf(props.sessionID)))
  const [pinned, setPinned] = createSignal(true)
  const status = () => state.sessions.session_status[props.sessionID]
  const running = () => busy(props.sessionID)

  const toBottom = () => scroller.scrollTo({ top: scroller.scrollHeight })
  onMount(() => {
    const observer = new ResizeObserver(() => pinned() && toBottom())
    observer.observe(content)
    onCleanup(() => observer.disconnect())
  })
  createEffect(
    on(
      () => props.sessionID,
      () => {
        setPinned(true)
        queueMicrotask(toBottom)
      },
    ),
  )

  return (
    <div
      class="messages scroll"
      ref={scroller}
      role="log"
      aria-label={t("conversation.log")}
      onScroll={() => setPinned(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40)}
    >
      <div class="messages-inner" ref={content}>
        <For each={grouped().orphans}>
          {(message) => (
            <Reply
              message={message}
              last={false}
              sessionID={props.sessionID}
              directory={props.directory}
              onReviewFile={props.onReviewFile}
            />
          )}
        </For>
        <For each={grouped().turns}>
          {(turn, index) => {
            const last = () => index() === grouped().turns.length - 1
            return (
              <section class="turn" classList={{ settled: !last() }}>
                <UserBubble message={turn.user} sessionID={props.sessionID} directory={props.directory} />
                <For each={turn.replies}>
                  {(message, i) => (
                    <Reply
                      message={message}
                      last={last() && i() === turn.replies.length - 1}
                      sessionID={props.sessionID}
                      directory={props.directory}
                      onReviewFile={props.onReviewFile}
                    />
                  )}
                </For>
                <Show when={!last() || !running()}>
                  <Changes turn={turn} directory={props.directory} onReview={props.onReviewTurn} />
                  <Show when={turn.replies.length && !turn.replies.some((message) => message.summary)}>
                    <TurnActions turn={turn} last={last()} sessionID={props.sessionID} directory={props.directory} />
                  </Show>
                </Show>
              </section>
            )
          }}
        </For>
        <Show when={running()}>
          <div class="working muted" aria-live="polite">
            <Show when={status()?.type === "retry"} fallback={<span class="pulse">{t("conversation.working")}</span>}>
              <RotateCw class="icon icon-sm" />
              {(() => {
                const value = status()
                return value?.type === "retry"
                  ? t("conversation.retry", { attempt: value.attempt, message: value.message })
                  : ""
              })()}
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}
