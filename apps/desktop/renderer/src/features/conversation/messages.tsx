import type {
  CollaborationEvent,
  ExternalDelegateProgress,
  FilePart,
  Part,
  ReasoningPart,
  ToolPart,
  SessionPlan,
} from "@merakcode/sdk/client"
import Brain from "lucide-solid/icons/brain"
import ChevronRight from "lucide-solid/icons/chevron-right"
import CircleAlert from "lucide-solid/icons/circle-alert"
import FileDiff from "lucide-solid/icons/file-diff"
import Copy from "lucide-solid/icons/copy"
import Pencil from "lucide-solid/icons/pencil"
import RotateCcw from "lucide-solid/icons/rotate-ccw"
import RotateCw from "lucide-solid/icons/rotate-cw"
import Undo2 from "lucide-solid/icons/undo-2"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  type JSX,
} from "solid-js"
import { t } from "../../i18n"
import { bridge } from "../../lib/bridge"
import { relative } from "../../lib/route"
import { busy, messagesOf, partsOf, state, state as store, statusKnown } from "../../state/store"
import { Markdown } from "../../ui/markdown"
import { copyDetails, toast } from "../../ui/toast"
import { summary } from "../../state/error"
import { AttachmentPreview } from "./attachment"
import { fill } from "./composer"
import { historyLocked, retry, revertTo, submissionOf } from "./send"
import { Avatar, seatMeta, type Product, type Seat } from "./members"
import { Tool, Explore } from "./tools"
import { PlanCard, usePlan } from "./plan"
import {
  answerBlocks,
  blocks,
  changes,
  eventsByTurn,
  segments,
  turns,
  type AssistantInfo as AssistantMessage,
  type UserInfo as UserMessage,
  type Block,
  type Segment,
  type Turn,
} from "./turns"

const isSummary = (message: AssistantMessage) => "summary" in message && message.summary

/** What a group conversation adds to the message list: who the members are and when they joined or left */
export type GroupView = {
  seats: readonly Seat[]
  events: readonly CollaborationEvent[]
  products: readonly Product[]
  /** Opens the child session a MerakCode member worked in */
  onOpenSession?: (sessionID: string) => void
  /** Opens a member in the member column */
  onOpenMember?: (seatID: string) => void
}

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

function Attachment(props: { part: FilePart; directory: string }) {
  return (
    <span class="attachment" title={props.part.filename ?? props.part.url}>
      <AttachmentPreview part={props.part} directory={props.directory} />
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
      .join("")
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
        <Show when={!historyLocked(props.sessionID)}>
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
        </Show>
        <div class="user-message selectable">
          <Show when={files().length}>
            <div class="attachments">
              <For each={files()}>{(part) => <Attachment part={part} directory={props.directory} />}</For>
            </div>
          </Show>
          <div class="user-text">{text()}</div>
        </div>
      </article>
    </Show>
  )
}

/** Actions after a turn's replies: copy the answer, and retry on the last turn */
function TurnActions(props: {
  turn: Turn
  last: boolean
  sessionID: string
  directory: string
  /** The text the copy button takes: the final answer while folded, the whole turn once expanded */
  text: () => string
}) {
  return (
    <div class="turn-actions">
      <Show when={props.text()}>
        <button
          class="icon-button sm"
          aria-label={t("common.copy")}
          title={t("common.copy")}
          onClick={() => void copy(props.text())}
        >
          <Copy class="icon icon-xs" />
        </button>
      </Show>
      <Show when={props.last && !historyLocked(props.sessionID)}>
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
  const [open, setOpen] = createSignal(false)
  const diffs = createMemo(() => changes(props.turn.replies.flatMap((message) => partsOf(message.id))))
  const totals = () =>
    diffs().reduce((sum, diff) => ({ add: sum.add + diff.additions, del: sum.del + diff.deletions }), {
      add: 0,
      del: 0,
    })
  return (
    <Show when={diffs().length}>
      <div class="changes-card" classList={{ open: open() }}>
        <div class="changes-head">
          <button class="changes-toggle" aria-expanded={open()} onClick={() => setOpen(!open())}>
            <ChevronRight class="icon icon-sm chevron" />
            <FileDiff class="icon icon-sm" />
            <span class="title">{t("conversation.changes")}</span>
            <span class="muted">{t("conversation.changesSummary", { files: diffs().length })}</span>
            <span class="add">+{totals().add}</span>
            <span class="del">−{totals().del}</span>
          </button>
          <button class="button secondary sm" onClick={() => props.onReview(props.turn.user.id)}>
            {t("conversation.review")}
          </button>
        </div>
        <Show when={open()}>
          <div class="change-list scroll">
            <For each={diffs()}>
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
      </div>
    </Show>
  )
}

function Reply(props: {
  plan?: SessionPlan
  message: AssistantMessage
  last: boolean
  sessionID: string
  directory: string
  onReviewFile: (file: string) => void
  /** Shows only the answer's words and files; used for a finished turn whose work is folded */
  answerOnly?: boolean
}) {
  const parts = () => partsOf(props.message.id)
  const list = createMemo(() => (props.answerOnly ? answerBlocks(parts()) : blocks(parts())))
  const done = (index: number) => props.answerOnly || !props.last || !busy(props.sessionID) || index < list().length - 1
  const [open, setOpen] = createSignal(false)
  // Summary written during context compaction, collapsed by default
  const summary = () =>
    parts()
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
  return (
    <Show
      when={!isSummary(props.message)}
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
      <Show when={props.message.execution?.kind === "external" && props.message.execution}>
        {(execution) => (
          <div class="external-signature subtle">
            {[execution().productTitle, execution().actualModel?.id ?? execution().requestedModel?.id]
              .filter(Boolean)
              .join(" · ")}
          </div>
        )}
      </Show>
      <Blocks blocks={list()} done={done} directory={props.directory} onReviewFile={props.onReviewFile} />
      <ErrorCard message={props.message} />
      <Show when={props.plan?.anchorMessageID === props.message.id}>
        <PlanCard sessionID={props.sessionID} directory={props.directory} plan={props.plan} />
      </Show>
    </Show>
  )
}

/**
 * A reply's blocks; done(index) says whether the block at index has finished streaming. The blocks are rebuilt on
 * every update and only ever grow at the end, so each is kept by its position: what the user opened stays open.
 */
function Blocks(props: {
  blocks: Block[]
  done: (index: number) => boolean
  directory: string
  onReviewFile: (file: string) => void
  /** In a group chat the words go in a bubble; steps stay outside it, as in an ordinary conversation */
  bubble?: boolean
}) {
  return (
    <Index each={props.blocks}>
      {(block, index) => (
        <Switch>
          <Match when={block().kind === "explore" && (block() as Extract<Block, { kind: "explore" }>)}>
            {(explore) => <Explore parts={explore().parts} directory={props.directory} />}
          </Match>
          <Match when={block().kind === "part" && (block() as Extract<Block, { kind: "part" }>).part}>
            {(part) => {
              const view = () => (
                <PartView
                  part={part()}
                  done={props.done(index)}
                  directory={props.directory}
                  onReviewFile={props.onReviewFile}
                />
              )
              return (
                <Show when={props.bubble && part().type === "text"} fallback={view()}>
                  <div class="bubble">{view()}</div>
                </Show>
              )
            }}
          </Match>
        </Switch>
      )}
    </Index>
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
      <Match when={props.part.type === "file" && props.part}>
        {(part) => <Attachment part={part()} directory={props.directory} />}
      </Match>
    </Switch>
  )
}

/** A message from a group member: avatar, name, product and role, then the bubble */
function Bubble(props: {
  id: string
  name: string
  meta: string
  leader?: boolean
  /** Opens the member in the member column; absent for a member who has left */
  onOpen?: () => void
  children: JSX.Element
}) {
  return (
    <article class="bubble-row" aria-label={props.name}>
      <Show when={props.onOpen} fallback={<Avatar id={props.id} name={props.name} />}>
        {(open) => (
          <button class="bubble-avatar" aria-label={props.name} onClick={() => open()()}>
            <Avatar id={props.id} name={props.name} />
          </button>
        )}
      </Show>
      <div class="bubble-main">
        <div class="bubble-who">
          <span class="bubble-name">{props.name}</span>
          <Show when={props.leader}>
            <span class="badge accent">{t("group.leader")}</span>
          </Show>
          <span class="subtle">{props.meta}</span>
        </div>
        {props.children}
      </div>
    </article>
  )
}

type DelegateInput = { seat?: string; task?: string; paths?: string[] }
type Step = { tool: string; detail: string }
type DelegateMetadata = {
  seatID?: string
  product?: string
  phase?: string
  sessionId?: string
  missing?: boolean
  steps?: Step[]
  /** When the member left the queue and began */
  started?: number
  external?: ExternalDelegateProgress
}

const stepText = (step: Step) => [step.tool, step.detail].filter(Boolean).join(" ")

function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(seconds / 60)
  return m ? t("group.minutes", { m, s: seconds % 60 }) : t("group.seconds", { s: seconds })
}

/** Ticks once a second while running, so the elapsed time stays current */
function Elapsed(props: { start: number; current?: Step }) {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))
  return (
    <span class="pulse muted">
      {[t("group.elapsed", { time: duration(now() - props.start) }), props.current && stepText(props.current)]
        .filter(Boolean)
        .join(" · ")}
    </span>
  )
}

/** What an external member did, folded by default */
function Steps(props: { steps: Step[] }) {
  const [open, setOpen] = createSignal(false)
  return (
    <div class="bubble-steps-list">
      <button class="button ghost sm" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <ChevronRight class="icon icon-xs chevron" />
        {t("group.steps", { count: props.steps.length })}
      </button>
      <Show when={open()}>
        <ol class="mono subtle">
          <For each={props.steps}>{(step) => <li>{stepText(step)}</li>}</For>
        </ol>
      </Show>
    </div>
  )
}

/** One delegate call shown as the member's own message. The name is the one used at the time. */
export function SeatBubble(props: { part: ToolPart; group: GroupView; stopped?: boolean }) {
  const state = () => props.part.state
  const input = () => state().input as DelegateInput
  const metadata = () => {
    const value = state()
    return (value.status === "pending" ? undefined : value.metadata) as DelegateMetadata | undefined
  }
  const name = () => input().seat ?? ""
  // A failed or stopped call keeps only its error details, so the member is found by the name it was called by
  const seat = () => {
    const id = metadata()?.seatID
    return id
      ? props.group.seats.find((item) => item.id === id)
      : props.group.seats.find((item) => item.name === name())
  }
  const meta = () => {
    const external = metadata()?.external
    const productID = metadata()?.product ?? seat()?.product ?? ""
    const product = props.group.products.find((item) => item.id === productID)
    const signature = external
      ? [external.productTitle, external.actualModel?.id ?? external.requestedModel?.id, seat()?.role]
          .filter(Boolean)
          .join(" · ")
      : seatMeta({ product: productID, role: seat()?.role }, props.group.products)
    return [
      signature,
      productID !== "merak" && product?.connected && product.capabilities.textStreaming === false
        ? t("conversation.outputOnCompletion")
        : undefined,
    ]
      .filter(Boolean)
      .join(" · ")
  }
  /** The task as the leader gave it: who asked, what, and where */
  const task = () => {
    const leader = props.group.seats.find((item) => item.leader)?.name
    const what = [input().task, ...(input().paths?.length ? [input().paths!.join(", ")] : [])].join(" · ")
    return input().task ? [leader, what].filter(Boolean).join("：") : ""
  }
  const reply = () => {
    const value = state()
    if (value.status !== "completed") return undefined
    // The output is the leader's English note; the user reads it in their own language
    const product = metadata()?.product ?? ""
    if (metadata()?.missing) return t("group.notInstalled", { title: seatMeta({ product }, props.group.products) })
    return value.output
  }
  /** The member asked the user something and waits: its requests carry this delegate call */
  const waiting = () => {
    const mine = (request: { tool?: { callID: string } }) => request.tool?.callID === props.part.callID
    const listed = <T extends { tool?: { callID: string } }>(lists: Record<string, T[]>) =>
      Object.values(lists).some((list) => list.some(mine))
    if (listed(store.sessions.question)) return t("group.waitingAnswer")
    if (listed(store.sessions.permission)) return t("group.waitingApproval")
  }
  const started = () => {
    const value = state()
    return value.status === "running" ? (metadata()?.started ?? value.time.start) : undefined
  }
  const failure = () => {
    const value = state()
    return value.status === "error" ? value.error : undefined
  }
  const open = () => {
    const id = seat()?.id
    const onOpen = props.group.onOpenMember
    return id && onOpen ? () => onOpen(id) : undefined
  }
  return (
    <Bubble id={seat()?.id ?? metadata()?.seatID ?? name()} name={name()} meta={meta()} onOpen={open()}>
      <Show when={task()}>
        <div class="bubble-task subtle ellipsis">↳ {task()}</div>
      </Show>
      <div class="bubble">
        <For each={metadata()?.external?.parts}>{(part) => <Markdown text={part.text} />}</For>
        <Switch>
          <Match when={metadata()?.external?.stopReason === "product-disabled"}>
            <span class="muted">{t("group.offline")}</span>
          </Match>
          <Match when={!metadata()?.external?.parts.length && reply()}>{(text) => <Markdown text={text()} />}</Match>
          {/* A stopped call reads as running until the turn is reloaded, then as aborted: both are "stopped" */}
          <Match when={props.stopped}>
            <span class="muted">{t("group.stopped")}</span>
          </Match>
          <Match when={failure()}>
            {(message) => <div class="bubble-error">{t("group.failed", { message: message() })}</div>}
          </Match>
          <Match when={state().status === "pending" || metadata()?.phase === "queued"}>
            <span class="pulse muted">{t("group.queued")}</span>
          </Match>
          <Match when={started() && waiting()}>{(text) => <span class="pulse bubble-waiting">{text()}</span>}</Match>
          <Match when={started()}>{(start) => <Elapsed start={start()} current={metadata()?.steps?.at(-1)} />}</Match>
        </Switch>
        <Show when={metadata()?.steps?.length}>
          <Steps steps={metadata()!.steps!} />
        </Show>
        <Show when={metadata()?.sessionId}>
          {(child) => (
            <button class="button ghost sm bubble-steps" onClick={() => props.group.onOpenSession?.(child())}>
              {t("group.process")}
            </button>
          )}
        </Show>
      </div>
    </Bubble>
  )
}

/** The leader's replies in a group turn, split at each delegate call into the leader's and the members' messages */
function GroupReplies(props: {
  plan?: SessionPlan
  replies: AssistantMessage[]
  last: boolean
  sessionID: string
  directory: string
  group: GroupView
  onReviewFile: (file: string) => void
}) {
  const list = createMemo(() =>
    segments(
      props.replies.filter((message) => !isSummary(message)).flatMap((message) => partsOf(message.id)),
      props.plan?.anchorMessageID,
    ),
  )
  const leader = () => props.group.seats.find((seat) => seat.leader)
  const planSegment = createMemo(() =>
    list().findLastIndex((segment) =>
      segment.kind === "seat"
        ? segment.part.messageID === props.plan?.anchorMessageID
        : segment.blocks.some((block) =>
            block.kind === "part"
              ? block.part.messageID === props.plan?.anchorMessageID
              : block.parts.some((part) => part.messageID === props.plan?.anchorMessageID),
          ),
    ),
  )
  /** The turn is over and this call did not end on its own: still marked running, or ended by the turn being stopped */
  const aborted = () => props.replies.some((message) => message.error?.name === "MessageAbortedError")
  const stopped = (part: ToolPart) =>
    !busy(props.sessionID) &&
    (part.state.status === "running" || part.state.status === "pending" || (part.state.status === "error" && aborted()))
  // Only the very last block of the turn can still be streaming
  const done = (segment: number, blocks: number) => (index: number) =>
    !props.last || !busy(props.sessionID) || segment < list().length - 1 || index < blocks - 1
  return (
    <>
      <For each={props.replies.filter(isSummary)}>
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
      {/* Rebuilt on every update and only grows at the end: kept by position, like the blocks */}
      <Index each={list()}>
        {(segment, index) => (
          <>
            <Switch>
              <Match when={segment().kind === "seat" && (segment() as Extract<Segment, { kind: "seat" }>).part}>
                {(part) => <SeatBubble part={part()} group={props.group} stopped={stopped(part())} />}
              </Match>
              <Match when={segment().kind === "leader" && (segment() as Extract<Segment, { kind: "leader" }>).blocks}>
                {(blocks) => (
                  <Bubble
                    id={leader()?.id ?? ""}
                    name={leader()?.name ?? ""}
                    meta={leader() ? seatMeta(leader()!, props.group.products) : ""}
                    leader
                    onOpen={
                      leader() && props.group.onOpenMember ? () => props.group.onOpenMember!(leader()!.id) : undefined
                    }
                  >
                    <Blocks
                      blocks={blocks()}
                      done={done(index, blocks().length)}
                      directory={props.directory}
                      onReviewFile={props.onReviewFile}
                      bubble
                    />
                  </Bubble>
                )}
              </Match>
            </Switch>
            <Show when={index === planSegment()}>
              <PlanCard sessionID={props.sessionID} directory={props.directory} plan={props.plan} />
            </Show>
          </>
        )}
      </Index>
      <For each={props.replies}>{(message) => <ErrorCard message={message} />}</For>
    </>
  )
}

function SystemLines(props: { events: readonly CollaborationEvent[] }) {
  const text = (event: CollaborationEvent) => {
    if (event.kind === "join") return t("group.joined", { names: event.names.join("、") })
    if (event.kind === "leave") return t("group.left", { name: event.names[0] ?? "" })
    return t("group.renamed", { from: event.names[0] ?? "", to: event.names[1] ?? "" })
  }
  return <For each={props.events}>{(event) => <div class="system-line">{text(event)}</div>}</For>
}

/** A new team: everyone in it, and how to start */
function GroupIntro(props: { group: GroupView }) {
  const alone = () => props.group.seats.length <= 1
  return (
    <div class="group-intro">
      <div class="group-intro-faces">
        <For each={props.group.seats}>{(seat) => <Avatar id={seat.id} name={seat.name} />}</For>
      </div>
      <div class="group-intro-name">
        {t("group.ready", { names: props.group.seats.map((seat) => seat.name).join("、") })}
      </div>
      <div class="muted">{alone() ? t("group.empty") : t("group.start")}</div>
    </div>
  )
}

/** A conversation's messages, shown by turn; follows new content while scrolled to the bottom */
export function Messages(props: {
  sessionID: string
  directory: string
  onReviewTurn: (messageID: string) => void
  onReviewFile: (file: string) => void
  /** Shows the conversation as a group chat: the user on the right, the leader and each member on the left */
  group?: GroupView
}) {
  let scroller!: HTMLDivElement
  let content!: HTMLDivElement
  const plan = usePlan(
    () => props.sessionID,
    () => props.directory,
  ).plan
  const grouped = createMemo(() => turns(messagesOf(props.sessionID)))
  const lastWorked = createMemo(() => grouped().turns.findLastIndex((turn) => turn.replies.length > 0))
  const events = createMemo(() =>
    eventsByTurn(
      props.group?.events ?? [],
      grouped().turns.map((turn) => turn.user.time.created),
    ),
  )
  const [pinned, setPinned] = createSignal(true)
  const status = () => state.sessions.session_status[props.sessionID]
  const running = () => busy(props.sessionID)

  const working = () => (
    <>
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
    </>
  )

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
        <Show when={props.group && !grouped().turns.length}>
          <GroupIntro group={props.group!} />
        </Show>
        <For each={grouped().orphans}>
          {(message) => (
            <Reply
              plan={plan()}
              message={message}
              last={false}
              sessionID={props.sessionID}
              directory={props.directory}
              onReviewFile={props.onReviewFile}
            />
          )}
        </For>
        {/* Turns are rebuilt on every update and only grow at the end: kept by position, so what was opened stays open */}
        <Index each={grouped().turns}>
          {(turn, index) => {
            const last = () => index === grouped().turns.length - 1
            // Latches once this turn is no longer the one the session is working on
            const done = createMemo(
              (previous) =>
                previous ||
                (turn().replies.length > 0 && (status() !== undefined || statusKnown(props.directory)) && !running()) ||
                index < lastWorked(),
              false,
            )
            const [open, setOpen] = createSignal(false)
            const answer = () => turn().replies.findLast((message) => !isSummary(message))
            const answerParts = () => partsOf(answer()?.id ?? "")
            const answerVisible = () => answerBlocks(answerParts())
            const foldable = () =>
              answer() !== undefined &&
              answerVisible().length > 0 &&
              (turn().replies.length > 1 || answerVisible().length < blocks(answerParts()).length)
            const folded = () => !props.group && done() && foldable()
            const elapsed = () => {
              const reply = turn().replies.at(-1)
              const end = reply?.time.completed ?? reply?.time.created
              return end === undefined ? 0 : Math.max(0, end - turn().user.time.created)
            }
            const toggle = () => {
              if (!open()) setPinned(false)
              setOpen(!open())
            }
            const copyText = () => {
              const foldedAnswer = folded() && !open() ? answer() : undefined
              const replies = foldedAnswer ? [foldedAnswer] : turn().replies
              return replies
                .flatMap((message) => partsOf(message.id))
                .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text.trim()] : []))
                .filter(Boolean)
                .join("\n\n")
            }
            return (
              <section class="turn" classList={{ settled: !last(), folded: folded() && !open() }}>
                <SystemLines events={events()[index] ?? []} />
                <UserBubble message={turn().user} sessionID={props.sessionID} directory={props.directory} />
                <Show when={folded()}>
                  <button class="step-head turn-summary" aria-expanded={open()} onClick={toggle}>
                    <span class="step-title">{t("conversation.worked", { time: duration(elapsed()) })}</span>
                    <ChevronRight class="icon icon-sm chevron" />
                  </button>
                </Show>
                <Show
                  when={!folded() || open()}
                  fallback={
                    <Show when={answer()}>
                      {(message) => (
                        <Reply
                          plan={plan()}
                          message={message()}
                          last={false}
                          answerOnly
                          sessionID={props.sessionID}
                          directory={props.directory}
                          onReviewFile={props.onReviewFile}
                        />
                      )}
                    </Show>
                  }
                >
                  <Show
                    when={props.group}
                    fallback={
                      <For each={turn().replies}>
                        {(message, i) => (
                          <Reply
                            plan={plan()}
                            message={message}
                            last={last() && i() === turn().replies.length - 1}
                            sessionID={props.sessionID}
                            directory={props.directory}
                            onReviewFile={props.onReviewFile}
                          />
                        )}
                      </For>
                    }
                  >
                    {(group) => (
                      <GroupReplies
                        plan={plan()}
                        replies={turn().replies}
                        last={last()}
                        sessionID={props.sessionID}
                        directory={props.directory}
                        group={group()}
                        onReviewFile={props.onReviewFile}
                      />
                    )}
                  </Show>
                </Show>
                {/* Review stays available once edits exist. The turn can still be marked running after the reply is on
                    screen, and hiding the card then leaves no Review button. */}
                <Show
                  when={
                    folded() &&
                    !open() &&
                    answer()?.id !== plan()?.anchorMessageID &&
                    turn().replies.some((reply) => reply.id === plan()?.anchorMessageID)
                  }
                >
                  <PlanCard sessionID={props.sessionID} directory={props.directory} plan={plan()} />
                </Show>
                <Show when={!last() || !running()}>
                  <Show when={turn().replies.length && !turn().replies.some(isSummary)}>
                    <TurnActions
                      turn={turn()}
                      last={last()}
                      sessionID={props.sessionID}
                      directory={props.directory}
                      text={copyText}
                    />
                  </Show>
                </Show>
                <Show when={last() && running()}>{working()}</Show>
                <Changes turn={turn()} directory={props.directory} onReview={props.onReviewTurn} />
              </section>
            )
          }}
        </Index>
        <SystemLines events={events().at(-1) ?? []} />
        <Show when={running() && !grouped().turns.length}>{working()}</Show>
      </div>
    </div>
  )
}
