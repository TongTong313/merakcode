import type { ReviewHunk } from "@merakcode/sdk/client"
import { createEffect, createMemo, on, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { t } from "../../i18n"
import { sameDir } from "../../lib/route"
import { checkoutOf, gitDirectory, onCheckoutChange, registerDirty } from "../../state/git"
import { addComment, commentDirectory, commentLine, setReview } from "./state"

type Target = { file: string; hunk: ReviewHunk }
type Draft = { text: string; target: Target; stale?: boolean }
const [drafts, setDrafts] = createStore<
  Record<string, { directory: string; sessionID: string; active?: string; items: Record<string, Draft> }>
>({})
const sync = (key: string) => {
  const value = drafts[key]
  if (value)
    registerDirty(
      value.directory,
      `draft:${value.sessionID}`,
      Object.values(value.items).filter((item) => item.text.trim()).length,
    )
}
onCheckoutChange((directory, change) => {
  if (!change.branchChanged) return
  for (const [key, value] of Object.entries(drafts)) {
    if (gitDirectory(value.directory) !== directory) continue
    for (const id of Object.keys(value.items)) setDrafts(key, "items", id, "stale", true)
  }
})

/** Comment input for the review sidebar. A hunk button only selects the target; the text is written here. */
export function CommentComposer(props: { directory: string; sessionID?: string; target?: Target }) {
  const context = () => `${gitDirectory(props.directory)}\u0000${props.sessionID ?? ""}`
  const selected = () => drafts[context()]?.active
  const draft = () => {
    const id = selected()
    const value = id ? drafts[context()]?.items[id] : undefined
    return props.target || value?.text ? value : undefined
  }
  const text = () => draft()?.text ?? ""
  const target = () => draft()?.target ?? props.target
  const setText = (text: string) => {
    const id = selected()
    if (!id) return
    setDrafts(context(), "items", id, "text", text)
    sync(context())
  }
  let box: HTMLTextAreaElement | undefined
  // A memo: data refreshes hand out new target objects for the same hunk, and only picking another hunk starts over
  const hunk = createMemo(() => props.target?.hunk.id)
  createEffect(
    on([hunk, context], ([id, key], previous) => {
      const previousKey = previous?.[1]
      const previousDraft = previousKey ? drafts[previousKey] : undefined
      if (
        previousKey &&
        previousKey !== key &&
        previousDraft &&
        previousDraft.sessionID === props.sessionID &&
        sameDir(gitDirectory(previousDraft.directory), gitDirectory(props.directory))
      ) {
        setDrafts(key, { ...previousDraft, directory: props.directory })
        setDrafts(previousKey, undefined!)
      }
      if (props.sessionID) commentDirectory(props.sessionID, props.directory)
      if (!id || !props.target || !props.sessionID) return
      const existing = draft()
      if (existing?.target.hunk.id !== id || existing.stale) {
        const entry = `${checkoutOf(props.directory) ?? ""}:${id}`
        const value = props.target
        setDrafts(key, (previous) => ({
          ...previous,
          directory: props.directory,
          sessionID: props.sessionID!,
          active: entry,
          items: {
            ...previous?.items,
            [entry]: previous?.items[entry] ?? {
              text: "",
              target: {
                file: value.file,
                hunk: { ...value.hunk, lines: value.hunk.lines.map((line) => ({ ...line })) },
              },
            },
          },
        }))
      }
      box?.focus()
    }),
  )
  const add = () => {
    const valueTarget = target()
    const value = text().trim()
    if (!valueTarget || !props.sessionID || !value || draft()?.stale) return
    addComment(props.sessionID, valueTarget.file, valueTarget.hunk, value)
    setText("")
  }
  return (
    <div class="comment-compose">
      <Show when={target()}>
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
        placeholder={target() ? t("review.commentPlaceholder") : t("review.commentPick")}
        disabled={!target() || !props.sessionID}
        value={text()}
        onInput={(event) => setText(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && text().trim()) add()
          if (event.key === "Escape") setReview("commenting", undefined)
        }}
      />
      <Show when={draft()?.stale}>
        <p class="branch-notice" role="status">
          {t("review.draftStale")}
        </p>
      </Show>
      <div class="row">
        <Show when={Object.values(drafts[context()]?.items ?? {}).some((item) => item.text.trim())}>
          <button
            class="button ghost sm"
            onClick={() => {
              const key = context()
              const value = drafts[key]
              if (value) setDrafts(key, reconcile({ ...value, items: {}, active: undefined }))
              sync(key)
              setReview("commenting", undefined)
            }}
          >
            {t("review.discardDraft")}
          </button>
        </Show>
        <span class="spacer" />
        <button
          class="button primary sm"
          disabled={!target() || !props.sessionID || !text().trim() || draft()?.stale}
          onClick={add}
        >
          {t("common.add")}
        </button>
      </div>
    </div>
  )
}
