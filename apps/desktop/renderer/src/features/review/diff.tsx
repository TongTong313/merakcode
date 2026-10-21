import type { ReviewFile, ReviewHunk, ReviewLine } from "@merakcode/sdk/client"
import type { ThemedToken } from "shiki/core"
import Check from "lucide-solid/icons/check"
import ChevronDown from "lucide-solid/icons/chevron-down"
import ChevronRight from "lucide-solid/icons/chevron-right"
import CircleCheck from "lucide-solid/icons/circle-check"
import LoaderCircle from "lucide-solid/icons/loader-circle"
import MessageSquare from "lucide-solid/icons/message-square"
import MessageSquarePlus from "lucide-solid/icons/message-square-plus"
import SquarePen from "lucide-solid/icons/square-pen"
import Trash2 from "lucide-solid/icons/trash"
import X from "lucide-solid/icons/x"
import { createEffect, createMemo, For, Index, Match, Show, Switch } from "solid-js"
import { t } from "../../i18n"
import { languageOf } from "../../lib/highlight"
import { openInCode } from "../../state/ui"
import { budget } from "./cache"
import type { ReviewData } from "./review"
import { commentsOf, isSeen, removeComment, review, setReview, toggleSeen, type Comment } from "./state"

type Tokens = { before?: ThemedToken[][]; after?: ThemedToken[][] }

/** One line of code: rendered from tokens once highlighted, as plain text before that */
function Code(props: { text: string; tokens?: ThemedToken[] }) {
  return (
    <span class="code">
      <Show when={props.tokens} fallback={props.text || " "}>
        <Index each={props.tokens}>
          {(token) => <span style={token().htmlStyle as Record<string, string>}>{token().content}</span>}
        </Index>
      </Show>
    </span>
  )
}

const sign = (kind: ReviewLine["kind"]) => (kind === "add" ? "+" : kind === "del" ? "-" : " ")
const tokensOf = (tokens: Tokens, line: ReviewLine) =>
  line.kind === "add" ? tokens.after?.[line.new! - 1] : tokens.before?.[(line.old ?? 1) - 1]

/** The hunk's lines, or only the first limit of them */
const linesOf = (hunk: ReviewHunk, limit?: number) => (limit === undefined ? hunk.lines : hunk.lines.slice(0, limit))

function Unified(props: { hunk: ReviewHunk; tokens: Tokens; limit?: number }) {
  return (
    <div class="lines unified">
      <For each={linesOf(props.hunk, props.limit)}>
        {(line) => (
          <div class={`line ${line.kind}`}>
            <span class="n">{line.old ?? ""}</span>
            <span class="n">{line.new ?? ""}</span>
            <span class="sign">{sign(line.kind)}</span>
            <Code text={line.text} tokens={tokensOf(props.tokens, line)} />
          </div>
        )}
      </For>
    </div>
  )
}

/** Side-by-side rows: consecutive deletions and additions pair up line by line; context appears on both sides */
function rows(lines: ReviewLine[]) {
  const result: { left?: ReviewLine; right?: ReviewLine }[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    if (line.kind === "context") {
      result.push({ left: line, right: line })
      index++
      continue
    }
    const dels: ReviewLine[] = []
    const adds: ReviewLine[] = []
    while (lines[index]?.kind === "del") dels.push(lines[index++]!)
    while (lines[index]?.kind === "add") adds.push(lines[index++]!)
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) result.push({ left: dels[i], right: adds[i] })
  }
  return result
}

function Split(props: { hunk: ReviewHunk; tokens: Tokens; limit?: number }) {
  const list = createMemo(() => rows(linesOf(props.hunk, props.limit)))
  const cell = (line: ReviewLine | undefined, side: "left" | "right") => (
    <Show when={line} fallback={<div class="line empty" />}>
      {(value) => (
        <div class={`line ${value().kind}`}>
          <span class="n">{side === "left" ? value().old : value().new}</span>
          <span class="sign">{sign(value().kind)}</span>
          <Code
            text={value().text}
            tokens={
              side === "left"
                ? props.tokens.before?.[(value().old ?? 1) - 1]
                : props.tokens.after?.[(value().new ?? 1) - 1]
            }
          />
        </div>
      )}
    </Show>
  )
  return (
    <div class="lines split">
      <For each={list()}>
        {(row) => (
          <div class="split-row">
            {cell(row.left, "left")}
            {cell(row.right, "right")}
          </div>
        )}
      </For>
    </div>
  )
}

function CommentView(props: { comment: Comment; sessionID: string }) {
  return (
    <div class="line-comment">
      <div class="who">
        <MessageSquare class="icon icon-xs" />
        {props.comment.file}:{props.comment.line}
        <span class="spacer" />
        <button
          class="icon-button sm"
          aria-label={t("common.remove")}
          onClick={() => removeComment(props.sessionID, props.comment.id)}
        >
          <Trash2 class="icon icon-xs" />
        </button>
      </div>
      <div class="selectable">{props.comment.text}</div>
    </div>
  )
}

export type Decide = (decision: "accept" | "reject", files?: { file: string; hunks?: string[] }[]) => Promise<void>

function Hunk(props: {
  file: ReviewFile
  hunk: ReviewHunk
  n: number
  sessionID?: string
  actions: { accept: boolean; reject: boolean }
  rejectLabel: string
  style: "unified" | "split"
  tokens: Tokens
  /** Lines to render; the rest wait for "show the rest" */
  limit?: number
  active: boolean
  onDecide: Decide
}) {
  const comments = () =>
    commentsOf(props.sessionID).filter(
      (comment) =>
        comment.file === props.file.file &&
        comment.line >= props.hunk.newStart &&
        comment.line < props.hunk.newStart + Math.max(1, props.hunk.newLines),
    )
  const decide = (decision: "accept" | "reject") =>
    void props.onDecide(decision, [{ file: props.file.file, hunks: [props.hunk.id] }])
  return (
    <div
      class="hunk"
      classList={{ active: props.active, accepted: props.hunk.state === "accepted" }}
      role="group"
      aria-label={t("review.hunk", { file: props.file.file, n: props.n })}
      data-hunk={props.hunk.id}
    >
      <div class="hunk-bar">
        <span class="where">
          @@ -{props.hunk.oldStart},{props.hunk.oldLines} +{props.hunk.newStart},{props.hunk.newLines} @@
        </span>
        <span class="ctx">{props.hunk.heading ?? ""}</span>
        <span class="spacer" />
        <Show when={props.hunk.state === "accepted"}>
          <span class="hunk-state accepted">
            <CircleCheck class="icon icon-xs" />
            {t("review.accepted", { count: 1 })}
          </span>
        </Show>
        <Show when={props.sessionID}>
          <button
            class="button ghost sm"
            aria-label={t("review.comment")}
            aria-pressed={review.commenting === props.hunk.id}
            onClick={() => setReview("commenting", props.hunk.id)}
          >
            <MessageSquarePlus class="icon icon-xs" />
            <span class="label">{t("review.comment")}</span>
          </button>
        </Show>
        <Show when={props.actions.reject}>
          <button class="button reject sm" onClick={() => decide("reject")}>
            <X class="icon icon-xs" />
            {props.rejectLabel}
            <Show when={props.active}>
              <kbd aria-hidden="true">R</kbd>
            </Show>
          </button>
        </Show>
        <Show when={props.actions.accept && props.hunk.state !== "accepted"}>
          <button class="button accept sm" onClick={() => decide("accept")}>
            <Check class="icon icon-xs" />
            {t("review.accept")}
            <Show when={props.active}>
              <kbd aria-hidden="true">A</kbd>
            </Show>
          </button>
        </Show>
      </div>
      <Show when={props.hunk.lines.length}>
        <Show
          when={props.style === "split"}
          fallback={<Unified hunk={props.hunk} tokens={props.tokens} limit={props.limit} />}
        >
          <Split hunk={props.hunk} tokens={props.tokens} limit={props.limit} />
        </Show>
      </Show>
      <For each={comments()}>{(comment) => <CommentView comment={comment} sessionID={props.sessionID!} />}</For>
    </div>
  )
}

/**
 * Changes to one file: a header (accept / reject the whole file) followed by its hunks. The hunks are fetched when
 * the file is opened (often already prefetched), highlighted in a worker, and only the first lines render until the
 * rest is asked for.
 */
export function FileDiff(props: {
  file: ReviewFile
  data: ReviewData
  sessionID?: string
  actions: { accept: boolean; reject: boolean }
  scope: string
  style: "unified" | "split"
  active?: string
  onDecide: Decide
}) {
  const collapsed = () => !props.data.open(props.file)
  const setCollapsed = (value: boolean) => props.data.setOpen(props.file, !value)
  const lang = () => languageOf(props.file.file)
  const detail = () => props.data.detail(props.file)
  createEffect(() => {
    if (!collapsed()) void props.data.loadDetail(props.file)
  })
  createEffect(() => {
    if (!collapsed() && detail().detail) void props.data.loadTokens(props.file, lang())
  })
  const hunks = () => detail().detail?.hunks ?? []
  const shown = createMemo(() => (props.data.all(props.file) ? undefined : budget(hunks())))
  const rest = () => {
    const counts = shown()
    if (!counts) return 0
    return hunks().reduce((sum, hunk, index) => sum + hunk.lines.length - counts[index]!, 0)
  }
  const rejectLabel = () => (props.scope === "staged" ? t("review.unstage") : t("review.reject"))
  const whole = (decision: "accept" | "reject") => void props.onDecide(decision, [{ file: props.file.file }])
  return (
    <section class="diff-file" role="region" aria-label={props.file.file} data-file={props.file.file}>
      <header class="diff-file-head">
        <button
          class="icon-button sm"
          aria-label={collapsed() ? t("review.expand") : t("review.collapse")}
          aria-expanded={!collapsed()}
          onClick={() => setCollapsed(!collapsed())}
        >
          {collapsed() ? <ChevronRight class="icon icon-sm" /> : <ChevronDown class="icon icon-sm" />}
        </button>
        <span class="path mono ellipsis selectable">{props.file.file}</span>
        <Show when={props.file.status !== "modified"}>
          <span class={`badge ${props.file.status === "added" ? "success" : "danger"}`}>
            {props.file.status === "added" ? t("review.added") : t("review.deleted")}
          </span>
        </Show>
        <span class="add">+{props.file.additions}</span>
        <span class="del">−{props.file.deletions}</span>
        <span class="spacer" />
        <Show when={props.file.status !== "deleted"}>
          <button
            class="icon-button sm"
            aria-label={t("review.openInCode")}
            title={t("review.openInCode")}
            onClick={() => openInCode(props.file.file)}
          >
            <SquarePen class="icon icon-xs" />
          </button>
        </Show>
        <label class="seen">
          <input
            type="checkbox"
            checked={isSeen(props.file)}
            onChange={() => {
              toggleSeen(props.file)
              props.data.setOpen(props.file, undefined)
            }}
          />
          {t("review.seen")}
        </label>
        <Show when={props.actions.reject}>
          <button class="button reject sm" onClick={() => whole("reject")}>
            {props.scope === "staged" ? t("review.unstage") : t("review.rejectFile")}
          </button>
        </Show>
        <Show when={props.actions.accept}>
          <button class="button accept sm" onClick={() => whole("accept")}>
            {t("review.acceptFile")}
          </button>
        </Show>
      </header>
      <Show when={!collapsed()}>
        <Show when={props.file.binary || props.file.truncated}>
          <div class="diff-note subtle">{props.file.binary ? t("review.binary") : t("review.truncated")}</div>
        </Show>
        <Switch>
          <Match when={detail().error}>{(error) => <div class="diff-note subtle">{error().message}</div>}</Match>
          <Match when={!detail().detail}>
            <div class="diff-note subtle row" role="status">
              <LoaderCircle class="icon icon-sm spinner" />
              {t("review.loadingFile")}
            </div>
          </Match>
        </Switch>
        <For each={hunks()}>
          {(hunk, index) => (
            <Show when={!hunk.lines.length || (shown()?.[index()] ?? hunk.lines.length) > 0}>
              <Hunk
                file={props.file}
                hunk={hunk}
                n={index() + 1}
                sessionID={props.sessionID}
                actions={props.actions}
                rejectLabel={rejectLabel()}
                style={props.style}
                tokens={detail().tokens ?? {}}
                limit={shown()?.[index()]}
                active={props.active === hunk.id}
                onDecide={props.onDecide}
              />
            </Show>
          )}
        </For>
        <Show when={rest() > 0}>
          <button class="button ghost sm show-rest" onClick={() => props.data.showAll(props.file)}>
            {t("review.showRest", { count: rest() })}
          </button>
        </Show>
      </Show>
    </section>
  )
}
