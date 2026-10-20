import CheckCheck from "lucide-solid/icons/check-check"
import MessageSquare from "lucide-solid/icons/message-square"
import Undo2 from "lucide-solid/icons/undo-2"
import { createEffect, createResource, For, Match, on, Show, Switch } from "solid-js"
import { t } from "../../i18n"
import { call, client } from "../../state/client"
import { folderOf } from "../../state/store"
import { Segmented } from "../../ui/segmented"
import { Select } from "../../ui/select"
import { toast } from "../../ui/toast"
import { send } from "../conversation/send"
import { Commit } from "./commit"
import { FileDiff } from "./diff"
import {
  clearComments,
  commentMessage,
  commentsOf,
  progress,
  review,
  scopeOptions,
  setReview,
  useReview,
} from "./state"

export type ReviewData = ReturnType<typeof useReview>

/** Scope picker (the branch scope can change its base branch) and progress */
export function ScopeBar(props: { folder: string; directory: string; data: ReviewData; sessionID?: string }) {
  const git = () => folderOf(props.folder)?.project?.vcs === "git"
  const count = () => progress(props.data.data())
  // Before a conversation starts, only the git scopes apply
  createEffect(() => {
    if (!props.sessionID && git() && (review.scope === "turn" || review.scope === "session"))
      setReview("scope", "unstaged")
  })
  const [branches] = createResource(
    () => review.scope === "branch" && props.directory,
    (directory) => call(client(directory).vcs.branches()).catch(() => [] as string[]),
  )
  const base = () => review.base ?? props.data.data()?.base
  const bases = () => {
    const list = branches() ?? []
    const current = base()
    return [...(current && !list.includes(current) ? [current] : []), ...list].map((value) => ({ value, label: value }))
  }
  return (
    <>
      <Segmented
        label={t("review.scope")}
        options={scopeOptions(git(), !!props.sessionID)}
        value={review.scope}
        onChange={(scope) => setReview({ scope, messageID: undefined, last: undefined })}
      />
      <Show when={review.scope === "branch" && bases().length}>
        <Select
          class="chip outlined"
          label={t("review.base")}
          options={bases()}
          value={base()}
          onChange={(value) => setReview({ base: value, last: undefined })}
          display={(option) => <span class="ellipsis">{option?.label}</span>}
        />
      </Show>
      <span class="spacer" />
      <Show when={review.scope === "branch" && count().total}>
        <span class="progress">
          {t("review.progress", count())}
          <span class="progress-bar">
            <span style={{ width: `${(count().done / Math.max(1, count().total)) * 100}%` }} />
          </span>
        </span>
      </Show>
    </>
  )
}

/** Pending comments, sent to the agent together */
function PendingComments(props: { sessionID?: string; directory: string }) {
  const comments = () => commentsOf(props.sessionID)
  const submit = async () => {
    if (!props.sessionID) return
    await send(props.sessionID, props.directory, { text: commentMessage(comments()), files: [] }).catch(
      (error: Error) => toast({ kind: "error", title: t("error.request", { message: error.message }), error: error }),
    )
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
        <button class="button primary sm" onClick={() => void submit()}>
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
  // Scroll to the file requested when the review was opened
  createEffect(
    on(
      () => [review.focus, result()] as const,
      ([focus]) => {
        if (!focus) return
        queueMicrotask(() =>
          scroller?.querySelector(`[data-file="${CSS.escape(focus)}"]`)?.scrollIntoView({ block: "start" }),
        )
      },
    ),
  )
  return (
    <div class="diff scroll" ref={scroller}>
      <Switch>
        <Match when={props.data.data.error}>
          <div class="empty-state subtle">{(props.data.data.error as Error).message}</div>
        </Match>
        <Match when={result() && !files().length}>
          <div class="empty-state subtle">{review.scope === "turn" ? t("review.emptyTurn") : t("review.empty")}</div>
        </Match>
      </Switch>
      <For each={files()}>
        {(file) => (
          <FileDiff
            file={file}
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
  return (
    <>
      <div class="review-sub">
        <ScopeBar folder={props.folder} directory={props.directory} data={props.data} sessionID={props.sessionID} />
      </div>
      <ReviewFiles sessionID={props.sessionID} data={props.data} style="unified" />
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
            onDone={() => void props.data.refetch()}
          />
        </div>
      </Show>
    </>
  )
}
