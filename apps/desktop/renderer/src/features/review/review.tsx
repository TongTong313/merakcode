import CheckCheck from "lucide-solid/icons/check-check"
import LoaderCircle from "lucide-solid/icons/loader-circle"
import MessageSquare from "lucide-solid/icons/message-square"
import Undo2 from "lucide-solid/icons/undo-2"
import { createEffect, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js"
import { t } from "../../i18n"
import { ReviewToolbar } from "./toolbar"
import { FileDiff } from "./diff"
import { CommentDrafts } from "./compose"
import { CommentSummary, commentsSending, submitComments } from "./comments"
import { clearComments, commentsOf, review, useReview } from "./state"

export type ReviewData = ReturnType<typeof useReview>

/** True once when() has held for ms, so quick loads do not flash a spinner */
function delayed(when: () => boolean, ms = 300) {
  const [shown, setShown] = createSignal(false)
  createEffect(() => {
    if (!when()) return setShown(false)
    const timer = setTimeout(() => setShown(true), ms)
    onCleanup(() => clearTimeout(timer))
  })
  return shown
}

/** Pending comments, sent to the agent together */
function PendingComments(props: { sessionID?: string; directory: string }) {
  const comments = () => commentsOf(props.sessionID, props.directory)
  return (
    <Show when={comments().length}>
      <div class="pending-comments">
        <MessageSquare class="icon icon-sm" />
        <details class="pending-comment-list">
          <summary>{t("review.pending", { count: comments().length })}</summary>
          <For each={comments()}>{(comment) => <CommentSummary comment={comment} />}</For>
        </details>
        <span class="spacer" />
        <button
          class="button ghost sm"
          onClick={() => props.sessionID && clearComments(props.sessionID, undefined, props.directory)}
        >
          {t("review.clearComments")}
        </button>
        <button
          class="button primary sm"
          disabled={commentsSending(props.sessionID, props.directory) || comments().some((comment) => comment.stale)}
          title={comments().some((comment) => comment.stale) ? t("review.draftStale") : undefined}
          onClick={() => void submitComments(props.sessionID, props.directory)}
        >
          {t("review.send")}
        </button>
      </div>
    </Show>
  )
}

/** Most recent decision with an undo button */
export function LastDecision(props: { data: ReviewData }) {
  return (
    <Show when={props.data.data()?.last}>
      {(last) => (
        <div class="decision" role="status">
          <span class="muted ellipsis">
            {last().decision === "accept"
              ? t("review.accepted", { count: last().count })
              : t("review.rejected", { count: last().count })}
          </span>
          <button
            class="button ghost sm"
            disabled={props.data.working() || props.data.refreshing()}
            onClick={() => void props.data.undo()}
          >
            <Undo2 class="icon icon-xs" />
            {t("review.undo")}
          </button>
        </div>
      )}
    </Show>
  )
}

/** File list with each file's hunks; the middle part shared by the panel and the maximized view */
export function ReviewFiles(props: {
  sessionID?: string
  data: ReviewData
  directory: string
  style: "unified" | "split"
  active?: { file: string; id?: string }
  files?: string[]
}) {
  let scroller!: HTMLDivElement
  const result = () => props.data.data()
  const files = () => (result()?.files ?? []).filter((file) => !props.files || props.files.includes(file.file))
  const waiting = delayed(props.data.loading)
  // Open and scroll to the file requested when the review was opened
  createEffect(
    on(
      () => [review.focus, result()] as const,
      ([focus, current]) => {
        const file = focus ? current?.files.find((item) => item.file === focus) : undefined
        if (!file) return
        props.data.setOpen(file, true)
        props.data.showAll(file)
        requestAnimationFrame(() =>
          scroller?.querySelector(`[data-file="${CSS.escape(file.file)}"]`)?.scrollIntoView({ block: "start" }),
        )
      },
    ),
  )
  return (
    <div class="diff scroll" ref={scroller}>
      <Switch>
        <Match when={!result() && props.data.error()}>
          {(error) => <div class="empty-state subtle">{error().message}</div>}
        </Match>
        <Match when={waiting()}>
          <div class="empty-state subtle" role="status">
            <LoaderCircle class="icon spinner" />
            {t("review.loading")}
          </div>
        </Match>
        <Match when={result() && !files().length}>
          <div class="empty-state subtle">{review.scope === "turn" ? t("review.emptyTurn") : t("review.empty")}</div>
        </Match>
      </Switch>
      <For each={files()}>
        {(file) => (
          <FileDiff
            file={file}
            data={props.data}
            sessionID={props.sessionID}
            actions={result()!.actions}
            directory={props.directory}
            style={props.style}
            active={props.active?.file === file.file ? props.active.id : undefined}
            disabled={props.data.working() || props.data.refreshing()}
            onDecide={props.data.decide}
          />
        )}
      </For>
    </div>
  )
}

/** Accept all / reject all */
export function BulkActions(props: { data: ReviewData }) {
  const actions = () => props.data.data()?.actions
  const any = () => (props.data.data()?.files.length ?? 0) > 0
  return (
    <>
      <Show when={actions()?.reject && any()}>
        <button
          class="button reject"
          disabled={props.data.working() || props.data.refreshing()}
          onClick={() => void props.data.decide("reject")}
        >
          {t("review.rejectAll")}
        </button>
      </Show>
      <Show when={actions()?.accept && any()}>
        <button
          class="button accept"
          disabled={props.data.working() || props.data.refreshing()}
          onClick={() => void props.data.decide("accept")}
        >
          <CheckCheck class="icon icon-sm" />
          {t("review.acceptAll")}
        </button>
      </Show>
    </>
  )
}

/** The review in the side panel */
export function ReviewPanel(props: { sessionID?: string; directory: string; data: ReviewData }) {
  return (
    <>
      <div class="review-sub">
        <ReviewToolbar data={props.data} sessionID={props.sessionID} />
      </div>
      <ReviewFiles sessionID={props.sessionID} directory={props.directory} data={props.data} style="unified" />
      <CommentDrafts
        sessionID={props.sessionID}
        directory={props.directory}
        files={props.data.data()?.files.map((file) => file.file)}
      />
      <PendingComments sessionID={props.sessionID} directory={props.directory} />
      <div class="review-foot">
        <LastDecision data={props.data} />
        <span class="spacer" />
        <BulkActions data={props.data} />
      </div>
    </>
  )
}
