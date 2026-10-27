import { createEffect, on, Show, For } from "solid-js"
import { createStore } from "solid-js/store"
import { t } from "../../i18n"
import { sameDir } from "../../lib/route"
import { gitDirectory, identityOf, onCheckoutChange, registerDirty } from "../../state/git"
import { addComment, commentDirectory, commentsOf, commentInView, review, setReview } from "./state"
import { commentLocation, type CommentTarget } from "./selection"

type Draft = { target: CommentTarget; text: string; stale?: boolean }
const [drafts, setDrafts] = createStore<Record<string, Draft>>({})
const sync = (target: CommentTarget) =>
  registerDirty(
    target.directory,
    `draft:${target.sessionID}`,
    Object.values(drafts).filter(
      (draft) =>
        sameDir(gitDirectory(draft.target.directory), gitDirectory(target.directory)) &&
        draft.target.sessionID === target.sessionID &&
        draft.text.trim(),
    ).length,
  )
onCheckoutChange((directory, change) => {
  if (!change.branchChanged) return
  for (const [key, draft] of Object.entries(drafts))
    if (sameDir(gitDirectory(draft.target.directory), gitDirectory(directory))) setDrafts(key, "stale", true)
})

/** The selected code owns its editor; drafts survive a diff or layout remount. */
export function CommentComposer(props: { target: CommentTarget }) {
  let box!: HTMLTextAreaElement
  const draft = () => drafts[props.target.key]
  const text = () => draft()?.text ?? ""
  createEffect(
    on(
      () => props.target.key,
      (key) => {
        commentDirectory(props.target.sessionID, props.target.directory)
        const relocating = props.target.relocating
        const previous = relocating ? drafts[relocating] : undefined
        if (!drafts[key]) {
          setDrafts(key, {
            target: props.target,
            text:
              previous?.text ??
              commentsOf(props.target.sessionID).find((comment) => comment.id === props.target.editing)?.text ??
              "",
          })
          if (relocating && relocating !== key) setDrafts(relocating, undefined!)
        }
        sync(props.target)
        queueMicrotask(() => box?.focus())
      },
    ),
  )
  const add = () => {
    if (!text().trim() || draft()?.stale || props.target.stale) return
    const target = props.target
    const value = text().trim()
    setDrafts(target.key, undefined!)
    sync(target)
    addComment(target.sessionID, target, value)
  }
  const discard = () => {
    setDrafts(props.target.key, undefined!)
    sync(props.target)
    setReview("commenting", undefined)
  }
  return (
    <div class="comment-compose">
      <div class="loc">{commentLocation(props.target)}</div>
      <textarea
        ref={box}
        class="input"
        aria-label={t("review.commentLabel")}
        placeholder={t("review.commentPlaceholder")}
        value={text()}
        onInput={(event) => {
          setDrafts(props.target.key, "text", event.currentTarget.value)
          sync(props.target)
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            add()
          }
          if (event.key === "Escape") {
            event.preventDefault()
            setReview("commenting", undefined)
          }
        }}
      />
      <Show when={draft()?.stale || props.target.stale}>
        <p class="branch-notice" role="status">
          {t("review.draftStale")}
        </p>
      </Show>
      <div class="row">
        <button class="button ghost sm" data-discard-draft onClick={discard}>
          {t("review.discardDraft")}
        </button>
        <span class="spacer" />
        <button
          class="button primary sm"
          disabled={!text().trim() || draft()?.stale || props.target.stale}
          onClick={add}
        >
          {t("common.add")}
        </button>
      </div>
    </div>
  )
}

/** Inactive drafts stay reachable even after their source hunk leaves the pending list. */
export function CommentDrafts(props: { directory: string; sessionID?: string; files: string[] | undefined }) {
  const matches = (target: CommentTarget) =>
    sameDir(gitDirectory(target.directory), gitDirectory(props.directory)) && target.sessionID === props.sessionID
  const inactive = () =>
    Object.entries(drafts).filter(
      ([key, draft]) =>
        matches(draft.target) &&
        draft.text.trim() &&
        (review.commenting?.key !== key || !commentInView(draft.target, props.directory, props.sessionID)),
    )
  const orphan = () => {
    const target = review.commenting
    return target &&
      props.files &&
      commentInView(target, props.directory, props.sessionID) &&
      !props.files.includes(target.file)
      ? target
      : undefined
  }
  createEffect(() => {
    const target = orphan()
    if (target && !target.stale) setReview("commenting", "stale", true)
  })
  return (
    <>
      <For each={inactive()}>
        {([key, draft]) => (
          <div class="review-draft row">
            <button
              class="button ghost sm ellipsis"
              aria-label={t("review.resumeDraft")}
              onClick={() =>
                setReview({
                  scope: draft.target.scope,
                  messageID: draft.target.messageID,
                  focus: draft.target.file,
                  commenting: {
                    ...draft.target,
                    branch: identityOf(props.directory)?.branch,
                    stale: draft.stale || draft.target.stale,
                  },
                })
              }
            >
              {commentLocation(draft.target)}
            </button>
            <span class="subtle ellipsis grow">{draft.text}</span>
            <button
              class="button ghost sm"
              data-discard-draft
              onClick={() => {
                const target = draft.target
                setDrafts(key, undefined!)
                sync(target)
              }}
            >
              {t("review.discardDraft")}
            </button>
          </div>
        )}
      </For>
      <Show when={orphan()}>{(target) => <CommentComposer target={target()} />}</Show>
    </>
  )
}
