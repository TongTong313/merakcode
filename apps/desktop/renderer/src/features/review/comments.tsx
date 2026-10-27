import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { t } from "../../i18n"
import { gitDirectory } from "../../state/git"
import { toast } from "../../ui/toast"
import { send } from "../conversation/send"
import { clearComments, commentMessage, commentsOf, removeComment, revealComment, type Comment } from "./state"
import { commentLocation } from "./selection"

const [sending, setSending] = createStore<Record<string, boolean>>({})
const keyOf = (sessionID: string | undefined, directory: string) => `${gitDirectory(directory)}\0${sessionID ?? ""}`
export const commentsSending = (sessionID: string | undefined, directory: string) =>
  !!sending[keyOf(sessionID, directory)]

/** Clear only the exact feedback accepted by the conversation; edits made during submission remain pending. */
export async function submitComments(sessionID: string | undefined, directory: string) {
  if (!sessionID || commentsSending(sessionID, directory)) return
  const submitted = commentsOf(sessionID, directory).map((comment) => ({
    ...comment,
    rows: comment.rows.map((row) => ({ ...row })),
  }))
  if (!submitted.length || submitted.some((comment) => comment.stale)) return
  const key = keyOf(sessionID, directory)
  setSending(key, true)
  try {
    await send(sessionID, directory, { text: commentMessage(submitted), files: [] })
    clearComments(sessionID, submitted, directory)
  } catch (error) {
    toast({ kind: "error", title: t("error.request", { message: (error as Error).message }), error })
  } finally {
    setSending(key, false)
  }
}

export function CommentSummary(props: { comment: Comment }) {
  return (
    <div class="comment-item">
      <div class="loc">
        <button class="button ghost sm comment-location" onClick={() => revealComment(props.comment)}>
          {commentLocation(props.comment)}
        </button>
        <span class="spacer" />
        <button
          class="icon-button sm"
          aria-label={t("review.editComment")}
          onClick={() => revealComment(props.comment, true)}
        >
          ✎
        </button>
        <button
          class="icon-button sm"
          aria-label={t("common.remove")}
          onClick={() => removeComment(props.comment.sessionID, props.comment.id)}
        >
          ×
        </button>
      </div>
      <div class="selectable">{props.comment.text}</div>
      <Show when={props.comment.stale}>
        <p class="branch-notice">{t("review.draftStale")}</p>
      </Show>
    </div>
  )
}
