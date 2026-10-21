import type { ReviewHunk } from "@merakcode/sdk/client"
import { createEffect, createMemo, createSignal, on, Show } from "solid-js"
import { t } from "../../i18n"
import { addComment, commentLine, setReview } from "./state"

/** Comment input for the review sidebar. A hunk button only selects the target; the text is written here. */
export function CommentComposer(props: { sessionID?: string; target?: { file: string; hunk: ReviewHunk } }) {
  const [text, setText] = createSignal("")
  let box: HTMLTextAreaElement | undefined
  // A memo: data refreshes hand out new target objects for the same hunk, and only picking another hunk starts over
  const hunk = createMemo(() => props.target?.hunk.id)
  createEffect(
    on(hunk, (id) => {
      if (!id) return
      setText("")
      box?.focus()
    }),
  )
  const add = () => {
    const target = props.target
    const value = text().trim()
    if (!target || !props.sessionID || !value) return
    addComment(props.sessionID, target.file, target.hunk, value)
    setText("")
  }
  return (
    <div class="comment-compose">
      <Show when={props.target}>
        {(target) => (
          <div class="loc">
            {target().file}:{commentLine(target().hunk)}
          </div>
        )}
      </Show>
      <textarea
        ref={box}
        class="input"
        aria-label={t("review.commentLabel")}
        placeholder={props.target ? t("review.commentPlaceholder") : t("review.commentPick")}
        disabled={!props.target || !props.sessionID}
        value={text()}
        onInput={(event) => setText(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && text().trim()) add()
          if (event.key === "Escape") setReview("commenting", undefined)
        }}
      />
      <div class="row">
        <span class="spacer" />
        <button class="button primary sm" disabled={!props.target || !props.sessionID || !text().trim()} onClick={add}>
          {t("common.add")}
        </button>
      </div>
    </div>
  )
}
