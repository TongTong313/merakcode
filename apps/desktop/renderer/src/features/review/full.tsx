import ArrowLeft from "lucide-solid/icons/arrow-left"
import Bot from "lucide-solid/icons/bot"
import Columns2 from "lucide-solid/icons/columns-2"
import Minimize2 from "lucide-solid/icons/minimize-2"
import Rows2 from "lucide-solid/icons/rows-2"
import type { ReviewFile } from "@merakcode/sdk/client"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { t } from "../../i18n"
import { session } from "../../state/store"
import { setUi } from "../../state/ui"
import { Segmented } from "../../ui/segmented"
import { toast } from "../../ui/toast"
import { send } from "../conversation/send"
import { CommentComposer } from "./compose"
import { Commit } from "./commit"
import { present } from "./present"
import { ReviewTree } from "./tree"
import { BulkActions, LastDecision, ReviewFiles, ScopeBar } from "./review"
import {
  clearComments,
  commentMessage,
  commentingOn,
  commentsOf,
  removeComment,
  review,
  setReview,
  useReview,
} from "./state"

/**
 * Review filling the whole window: file list on the left, hunks in the middle (side by side by default), comments and
 * commit on the right. Keys: J / K next / previous hunk, A accept, R reject, C comment, ] next file.
 */
export function ReviewFull(props: { sessionID?: string; directory: string; folder: string }) {
  const data = useReview(
    () => props.sessionID,
    () => props.directory,
  )
  const [active, setActive] = createSignal<string>()
  const files = () => data.data()?.files ?? []
  // Every hunk in order; a file whose hunks are not loaded yet stands in as one entry without an id
  const hunks = createMemo(() =>
    files().flatMap((file) => {
      const loaded = data.detail(file).detail
      return loaded
        ? loaded.hunks.map((hunk) => ({ file, id: hunk.id as string | undefined }))
        : [{ file, id: undefined }]
    }),
  )
  const comments = () => commentsOf(props.sessionID)

  const focus = (file: ReviewFile, id: string | undefined) => {
    setActive(id)
    if (!id) return
    data.setOpen(file, true)
    data.showAll(file)
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-hunk="${CSS.escape(id)}"] .hunk-bar`)
      if (el) present(el)
    })
  }
  /** Opens a file from the list: centers the file header and highlights it */
  const openFile = async (file: ReviewFile) => {
    data.setOpen(file, true)
    const detail = await data.loadDetail(file)
    const id = detail?.hunks[0]?.id
    if (id) setActive(id)
    const el = document.querySelector(`[data-file="${CSS.escape(file.file)}"] .diff-file-head`)
    if (el) present(el)
  }
  /** Opens a file, loads its hunks if needed, then centers the requested hunk */
  const reveal = async (file: ReviewFile, last = false) => {
    data.setOpen(file, true)
    const detail = await data.loadDetail(file)
    focus(file, (last ? detail?.hunks.at(-1) : detail?.hunks[0])?.id)
  }
  const move = (step: number) => {
    const list = hunks()
    const index = list.findIndex((item) => item.id !== undefined && item.id === active())
    const target = list[Math.min(list.length - 1, Math.max(0, index + step))]
    if (!target) return
    if (target.id) return focus(target.file, target.id)
    void reveal(target.file, step < 0)
  }

  onMount(() => {
    const listener = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target.closest("input, textarea, [contenteditable]") || event.ctrlKey || event.metaKey || event.altKey) return
      const current = hunks().find((item) => item.id !== undefined && item.id === active())
      const key = event.key.toLowerCase()
      if (key === "j") move(1)
      else if (key === "k") move(-1)
      else if (key === "a" && current?.id && data.data()?.actions.accept)
        void data.decide("accept", [{ file: current.file.file, hunks: [current.id] }])
      else if (key === "r" && current?.id && data.data()?.actions.reject)
        void data.decide("reject", [{ file: current.file.file, hunks: [current.id] }])
      else if (key === "c" && current?.id) setReview("commenting", current.id)
      else if (key === "]") {
        const index = files().findIndex((file) => file.file === current?.file.file)
        const file = files()[(index + 1) % Math.max(1, files().length)]
        if (file) void openFile(file)
      } else if (key === "escape") setUi("maximized", false)
      else return
      event.preventDefault()
    }
    window.addEventListener("keydown", listener)
    onCleanup(() => window.removeEventListener("keydown", listener))
  })

  const sendComments = async () => {
    const sessionID = props.sessionID
    if (!sessionID) return
    await send(sessionID, props.directory, { text: commentMessage(comments()), files: [] }).catch((error: Error) =>
      toast({ kind: "error", title: t("error.request", { message: error.message }), error: error }),
    )
    clearComments(sessionID)
  }

  return (
    <main class="review-full" aria-label={t("review.label")}>
      <div class="review-full-bar drag">
        <button class="button ghost no-drag" onClick={() => setUi("maximized", false)}>
          <ArrowLeft class="icon icon-sm" />
          {t("review.back")}
        </button>
        <span class="title ellipsis">
          {t("review.label")}
          <Show when={props.sessionID}>{(id) => ` · ${session(id())?.title ?? ""}`}</Show>
        </span>
        <div class="no-drag row grow">
          <ScopeBar folder={props.folder} directory={props.directory} data={data} sessionID={props.sessionID} />
          <Segmented
            label={t("review.split")}
            options={[
              { value: "split", label: t("review.split"), icon: Columns2 },
              { value: "unified", label: t("review.unified"), icon: Rows2 },
            ]}
            value={review.style}
            onChange={(style) => setReview("style", style)}
          />
          <BulkActions data={data} />
          <button class="icon-button" aria-label={t("panel.restore")} onClick={() => setUi("maximized", false)}>
            <Minimize2 class="icon icon-sm" />
          </button>
        </div>
      </div>
      <div class="review-full-body">
        <aside class="review-tree" aria-label={t("review.files")}>
          <ReviewTree
            files={files()}
            activeFile={hunks().find((item) => item.id !== undefined && item.id === active())?.file.file}
            onOpen={(file) => void openFile(file)}
          />
          <div class="keys">
            <span>
              <kbd>J</kbd>
              <kbd>K</kbd>
              {t("review.keys.next")}
            </span>
            <span>
              <kbd>A</kbd>
              {t("review.accept")}
            </span>
            <span>
              <kbd>R</kbd>
              {t("review.reject")}
            </span>
            <span>
              <kbd>C</kbd>
              {t("review.comment")}
            </span>
            <span>
              <kbd>]</kbd>
              {t("review.keys.file")}
            </span>
          </div>
        </aside>
        <section class="review-center">
          <ReviewFiles sessionID={props.sessionID} data={data} style={review.style} active={active()} />
          <div class="review-foot">
            <LastDecision data={data} />
          </div>
        </section>
        <aside class="review-side" aria-label={t("review.comments")}>
          <div class="side-head">{t("review.comments")}</div>
          <Show when={props.sessionID}>
            <CommentComposer sessionID={props.sessionID} target={commentingOn(files(), (file) => data.detail(file))} />
          </Show>
          <div class="side-list scroll">
            <Show when={comments().length} fallback={<p class="subtle side-empty">{t("review.noComments")}</p>}>
              <For each={comments()}>
                {(comment) => (
                  <div class="comment-item">
                    <div class="loc">
                      {comment.file}:{comment.line}
                      <span class="spacer" />
                      <button
                        class="icon-button sm"
                        aria-label={t("common.remove")}
                        onClick={() => {
                          const sessionID = props.sessionID
                          if (sessionID) removeComment(sessionID, comment.id)
                        }}
                      >
                        ×
                      </button>
                    </div>
                    <div class="selectable">{comment.text}</div>
                  </div>
                )}
              </For>
            </Show>
          </div>
          <div class="side-foot">
            <Show when={props.sessionID}>
              <button class="button primary" disabled={!comments().length} onClick={() => void sendComments()}>
                <Bot class="icon icon-sm" />
                {t("review.send")}
              </button>
            </Show>
            <Show when={review.scope === "staged" || review.scope === "unstaged"}>
              <hr class="divider" />
              <Commit
                directory={props.directory}
                all={review.scope === "unstaged"}
                pending={files().length > 0}
                onDone={() => void data.refetch()}
              />
            </Show>
          </div>
        </aside>
      </div>
    </main>
  )
}
