import CheckCheck from "lucide-solid/icons/check-check"
import LoaderCircle from "lucide-solid/icons/loader-circle"
import MessageSquare from "lucide-solid/icons/message-square"
import Undo2 from "lucide-solid/icons/undo-2"
import { createEffect, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js"
import { t } from "../../i18n"
import { toast } from "../../ui/toast"
import { send } from "../conversation/send"
import { CommentComposer } from "./compose"
import { Commit } from "./commit"
import { ReviewToolbar } from "./toolbar"
import { FileDiff } from "./diff"
import { clearComments, commentMessage, commentingOn, commentsOf, review, useReview } from "./state"

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
  const comments = () => commentsOf(props.sessionID)
  const submit = async () => {
    if (!props.sessionID) return
    if (comments().some((comment) => comment.stale)) return
    const sent = await send(props.sessionID, props.directory, { text: commentMessage(comments()), files: [] }).then(
      () => true,
      (error: Error) => {
        toast({ kind: "error", title: t("error.request", { message: error.message }), error })
        return false
      },
    )
    if (!sent) return
    clearComments(props.sessionID)
  }
  return (
    <Show when={comments().length}>
      <div class="pending-comments">
        <MessageSquare class="icon icon-sm" />
        <span>{t("review.pending", { count: comments().length })}</span>
        <span class="spacer" />
        <button class="button ghost sm" onClick={() => props.sessionID && clearComments(props.sessionID)}>
          {t("review.clearComments")}
        </button>
        <button
          class="button primary sm"
          disabled={comments().some((comment) => comment.stale)}
          title={comments().some((comment) => comment.stale) ? t("review.draftStale") : undefined}
          onClick={() => void submit()}
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
    <Show when={review.last}>
      {(last) => (
        <div class="decision" role="status">
          <span class="muted ellipsis">
            {last().decision === "accept"
              ? t("review.accepted", { count: last().count })
              : t("review.rejected", { count: last().count })}
          </span>
          <button class="button ghost sm" onClick={() => void props.data.undo()}>
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
  style: "unified" | "split"
  active?: string
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
          <div class="empty-state subtle">
            {review.scope === "branch" && !result()?.base
              ? t("git.choose")
              : review.scope === "turn"
                ? t("review.emptyTurn")
                : t("review.empty")}
          </div>
        </Match>
      </Switch>
      <For each={files()}>
        {(file) => (
          <FileDiff
            file={file}
            data={props.data}
            sessionID={props.sessionID}
            actions={result()!.actions}
            scope={review.scope}
            style={props.style}
            active={props.active}
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
        <button class="button reject" onClick={() => void props.data.decide("reject")}>
          {review.scope === "staged" ? t("review.unstage") : t("review.rejectAll")}
        </button>
      </Show>
      <Show when={actions()?.accept && any()}>
        <button class="button accept" onClick={() => void props.data.decide("accept")}>
          <CheckCheck class="icon icon-sm" />
          {t("review.acceptAll")}
        </button>
      </Show>
    </>
  )
}

/** The review in the side panel */
export function ReviewPanel(props: { sessionID?: string; directory: string; folder: string; data: ReviewData }) {
  const target = () => commentingOn(props.data.data()?.files ?? [], (file) => props.data.detail(file))
  return (
    <>
      <div class="review-sub">
        <ReviewToolbar
          folder={props.folder}
          directory={props.directory}
          data={props.data}
          sessionID={props.sessionID}
        />
      </div>
      <ReviewFiles sessionID={props.sessionID} data={props.data} style="unified" />
      <Show when={props.sessionID}>
        <CommentComposer directory={props.directory} sessionID={props.sessionID} target={target()} />
      </Show>
      <PendingComments sessionID={props.sessionID} directory={props.directory} />
      <div class="review-foot">
        <LastDecision data={props.data} />
        <span class="spacer" />
        <BulkActions data={props.data} />
      </div>
      <Show when={review.scope === "staged" || review.scope === "unstaged"}>
        <div class="review-commit">
          <Commit
            directory={props.directory}
            all={review.scope === "unstaged"}
            pending={(props.data.data()?.files.length ?? 0) > 0}
            onDone={() => void props.data.refetch()}
          />
        </div>
      </Show>
    </>
  )
}
