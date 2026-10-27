import type { ReviewFile, ReviewHunk, ReviewLine } from "@merakcode/sdk/client"
import type { ThemedToken } from "shiki/core"
import Check from "lucide-solid/icons/check"
import ChevronDown from "lucide-solid/icons/chevron-down"
import ChevronRight from "lucide-solid/icons/chevron-right"
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
import { CommentComposer } from "./compose"
import { present } from "./present"
import { commentLocation, excerptOf, type CommentTarget } from "./selection"
import {
  beginComment,
  commentsOf,
  isSeen,
  removeComment,
  review,
  setReview,
  toggleSeen,
  commentInView,
  refreshCommentAnchors,
  revealComment,
  type Comment,
} from "./state"

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

type LineContext = {
  file: ReviewFile
  directory: string
  sessionID?: string
  hunk: ReviewHunk
  tokens: Tokens
  limit?: number
  side?: "old" | "new"
}

function selectedLine(props: LineContext, index: number, side: "unified" | "old" | "new") {
  const target = review.selecting ?? review.commenting
  return (
    !!target &&
    commentInView(target, props.directory, props.sessionID) &&
    target.file === props.file.file &&
    (side === "unified" || target.side === "unified" || target.side === side) &&
    target.rows.some((row) => row.hunk === props.hunk.id && row.index === index)
  )
}

function Unified(props: LineContext) {
  return (
    <div class="lines unified">
      <For each={linesOf(props.hunk, props.limit)}>
        {(line, index) => (
          <>
            <div
              class={`line ${line.kind}`}
              classList={{ "selected-code": selectedLine(props, index(), "unified") }}
              data-line-index={index()}
              data-hunk-line={props.hunk.id}
              data-side="unified"
            >
              <span class="n">{line.old ?? ""}</span>
              <span class="n">{line.new ?? ""}</span>
              <span class="sign">{sign(line.kind)}</span>
              <Code text={line.text} tokens={tokensOf(props.tokens, line)} />
              <Show when={props.sessionID}>
                <button
                  class="line-comment-add"
                  aria-label={t("review.commentLine", { line: line.new ?? line.old ?? 0 })}
                  onClick={() =>
                    beginComment(props.directory, props.sessionID!, props.file.file, props.file.version, [
                      { ...line, hunk: props.hunk.id, index: index() },
                    ])
                  }
                >
                  <MessageSquarePlus class="icon icon-xs" />
                </button>
              </Show>
            </div>
            <LineComments {...props} index={index()} />
          </>
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

function Split(props: LineContext) {
  const list = createMemo(() => rows(linesOf(props.hunk, props.limit)))
  const cell = (line: ReviewLine | undefined, side: "left" | "right") => (
    <Show when={line} fallback={<div class="line empty" />}>
      {(value) => (
        <div
          class={`line ${value().kind}`}
          classList={{
            "selected-code": selectedLine(props, props.hunk.lines.indexOf(value()), side === "left" ? "old" : "new"),
          }}
          data-line-index={props.hunk.lines.indexOf(value())}
          data-hunk-line={props.hunk.id}
          data-side={side === "left" ? "old" : "new"}
        >
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
          <Show when={props.sessionID}>
            <button
              class="line-comment-add"
              aria-label={t("review.commentLine", { line: (side === "left" ? value().old : value().new) ?? 0 })}
              onClick={() =>
                beginComment(
                  props.directory,
                  props.sessionID!,
                  props.file.file,
                  props.file.version,
                  [{ ...value(), hunk: props.hunk.id, index: props.hunk.lines.indexOf(value()) }],
                  side === "left" ? "old" : "new",
                )
              }
            >
              <MessageSquarePlus class="icon icon-xs" />
            </button>
          </Show>
        </div>
      )}
    </Show>
  )
  return (
    <div class="lines split">
      <For each={list()}>
        {(row) => (
          <>
            <div class="split-row">
              {cell(row.left, "left")}
              {cell(row.right, "right")}
            </div>
            <div class="split-row split-annotations">
              <div>
                <Show when={row.left}>
                  <LineComments {...props} side="old" index={props.hunk.lines.indexOf(row.left!)} />
                </Show>
              </div>
              <div>
                <Show when={row.right}>
                  <LineComments {...props} side="new" index={props.hunk.lines.indexOf(row.right!)} />
                </Show>
              </div>
            </div>
          </>
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
        <button class="button ghost sm comment-location" onClick={() => revealComment(props.comment)}>
          {commentLocation(props.comment)}
        </button>
        <span class="spacer" />
        <button
          class="icon-button sm"
          aria-label={t("review.editComment")}
          onClick={() => revealComment(props.comment, true)}
        >
          <SquarePen class="icon icon-xs" />
        </button>
        <button
          class="icon-button sm"
          aria-label={t("common.remove")}
          onClick={() => removeComment(props.sessionID, props.comment.id)}
        >
          <Trash2 class="icon icon-xs" />
        </button>
      </div>
      <div class="selectable">{props.comment.text}</div>
      <details>
        <summary>{t("review.selectedCode")}</summary>
        <pre class="comment-excerpt">{excerptOf(props.comment)}</pre>
      </details>
    </div>
  )
}

function LineComments(props: LineContext & { index: number }) {
  const matches = (comment: CommentTarget) =>
    commentInView(comment, props.directory, props.sessionID) &&
    comment.file === props.file.file &&
    (!props.side ||
      (comment.side === "unified" ? (comment.rows.at(-1)?.new === undefined ? "old" : "new") : comment.side) ===
        props.side) &&
    comment.rows.at(-1)?.hunk === props.hunk.id &&
    comment.rows.at(-1)?.index === props.index
  const target = () => {
    const value = review.commenting
    return value && matches(value) ? value : undefined
  }
  const selected = () => {
    const value = review.selecting
    return value && matches(value) ? value : undefined
  }
  return (
    <>
      <Show when={selected()}>
        {(selection) => (
          <button
            class="button secondary sm selection-comment-add"
            onClick={() => {
              const value = selection()
              setReview("selecting", undefined)
              setReview("commenting", value)
            }}
          >
            {t("review.selectionComment")}
          </button>
        )}
      </Show>
      <For each={commentsOf(props.sessionID).filter(matches)}>
        {(comment) => <CommentView comment={comment} sessionID={props.sessionID!} />}
      </For>
      <Show when={target()}>{(selection) => <CommentComposer target={selection()} />}</Show>
    </>
  )
}

export type Decide = (decision: "accept" | "reject", files?: { file: string; hunks?: string[] }[]) => Promise<void>

function Hunk(props: {
  file: ReviewFile
  hunk: ReviewHunk
  n: number
  directory: string
  sessionID?: string
  actions: { accept: boolean; reject: boolean }
  rejectLabel: string
  style: "unified" | "split"
  tokens: Tokens
  /** Lines to render; the rest wait for "show the rest" */
  limit?: number
  active: boolean
  onDecide: Decide
  disabled?: boolean
}) {
  const decide = (decision: "accept" | "reject") =>
    void props.onDecide(decision, [{ file: props.file.file, hunks: [props.hunk.id] }])
  return (
    <div
      class="hunk"
      classList={{ active: props.active }}
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
        <Show when={props.actions.reject}>
          <button class="button reject sm" disabled={props.disabled} onClick={() => decide("reject")}>
            <X class="icon icon-xs" />
            {props.rejectLabel}
            <Show when={props.active}>
              <kbd aria-hidden="true">R</kbd>
            </Show>
          </button>
        </Show>
        <Show when={props.actions.accept}>
          <button class="button accept sm" disabled={props.disabled} onClick={() => decide("accept")}>
            <Check class="icon icon-xs" />
            {t("review.accept")}
            <Show when={props.active}>
              <kbd aria-hidden="true">A</kbd>
            </Show>
          </button>
        </Show>
      </div>
      <Show when={props.hunk.lines.length}>
        <Show when={props.style === "split"} fallback={<Unified {...props} />}>
          <Split {...props} />
        </Show>
      </Show>
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
  directory: string
  style: "unified" | "split"
  active?: string
  onDecide: Decide
  disabled?: boolean
}) {
  let root!: HTMLElement
  const selectedCode = (event: MouseEvent) => {
    if (!props.sessionID || (event.target as Element).closest("button,textarea,input")) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return
    const range = selection.getRangeAt(0)
    const rowOf = (node: Node | null) =>
      (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>(".line[data-line-index]")
    const first = rowOf(range.startContainer)
    const last = rowOf(range.endContainer)
    if (!first || !last || !root.contains(first) || !root.contains(last) || first.dataset.side !== last.dataset.side)
      return
    const side = first.dataset.side as "old" | "new" | "unified"
    const lines = [...root.querySelectorAll<HTMLElement>(`.line[data-side="${side}"]`)]
    const start = lines.indexOf(first)
    const ending = document.createRange()
    ending.selectNodeContents(last.querySelector(".code")!)
    ending.setEnd(range.endContainer, range.endOffset)
    const end = lines.indexOf(last) + (ending.toString() ? 1 : 0)
    const selected = lines.slice(start, end).flatMap((row) => {
      const hunk = hunks().find((hunk) => hunk.id === row.dataset.hunkLine)
      const index = Number(row.dataset.lineIndex)
      const line = hunk?.lines[index]
      return line && hunk ? [{ ...line, hunk: hunk.id, index }] : []
    })
    beginComment(props.directory, props.sessionID, props.file.file, props.file.version, selected, side, false)
  }
  const collapsed = () => !props.data.open(props.file)
  const setCollapsed = (value: boolean) => props.data.setOpen(props.file, !value)
  const lang = () => languageOf(props.file.file)
  const detail = () => props.data.detail(props.file)
  createEffect(() => {
    const loaded = detail().detail
    if (loaded && props.sessionID) refreshCommentAnchors(props.directory, props.sessionID, loaded)
  })
  createEffect(() => {
    if (!collapsed()) void props.data.loadDetail(props.file)
  })
  createEffect(() => {
    if (!collapsed() && detail().detail) void props.data.loadTokens(props.file, lang())
  })
  const hunks = () => detail().detail?.hunks ?? []
  createEffect(() => {
    const reveal = review.reveal
    if (review.focus !== props.file.file || !reveal || !detail().detail) return
    const line = hunks().find((hunk) => hunk.id === reveal.hunk)?.lines[reveal.index]
    const side =
      props.style === "unified"
        ? "unified"
        : reveal.side === "unified"
          ? line?.new === undefined
            ? "old"
            : "new"
          : reveal.side
    requestAnimationFrame(() => {
      const line = root?.querySelector(
        `[data-hunk-line="${CSS.escape(reveal.hunk)}"][data-line-index="${reveal.index}"][data-side="${side}"]`,
      )
      if (line) present(line)
    })
  })
  const detached = () => {
    const target = review.commenting
    if (!target?.stale || target.file !== props.file.file || !commentInView(target, props.directory, props.sessionID))
      return
    const end = target.rows.at(-1)
    if (!hunks().some((hunk) => hunk.id === end?.hunk && hunk.lines[end.index])) return target
  }
  const shown = createMemo(() => (props.data.all(props.file) ? undefined : budget(hunks())))
  const rest = () => {
    const counts = shown()
    if (!counts) return 0
    return hunks().reduce((sum, hunk, index) => sum + hunk.lines.length - counts[index]!, 0)
  }
  const rejectLabel = () => t("review.reject")
  const whole = (decision: "accept" | "reject") => void props.onDecide(decision, [{ file: props.file.file }])
  return (
    <section
      ref={root}
      onMouseUp={selectedCode}
      class="diff-file"
      role="region"
      aria-label={props.file.file}
      data-file={props.file.file}
    >
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
          <button class="button reject sm" disabled={props.disabled} onClick={() => whole("reject")}>
            {t("review.rejectFile")}
          </button>
        </Show>
        <Show when={props.actions.accept}>
          <button class="button accept sm" disabled={props.disabled} onClick={() => whole("accept")}>
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
                directory={props.directory}
                hunk={hunk}
                n={index() + 1}
                sessionID={props.sessionID}
                actions={props.actions}
                rejectLabel={rejectLabel()}
                style={props.style}
                tokens={detail().tokens ?? {}}
                limit={shown()?.[index()]}
                active={props.active === hunk.id}
                disabled={props.disabled}
                onDecide={props.onDecide}
              />
            </Show>
          )}
        </For>
        <Show when={detached()}>{(target) => <CommentComposer target={target()} />}</Show>
        <Show when={rest() > 0}>
          <button class="button ghost sm show-rest" onClick={() => props.data.showAll(props.file)}>
            {t("review.showRest", { count: rest() })}
          </button>
        </Show>
      </Show>
    </section>
  )
}
