import type { ReviewFile } from "@merakcode/sdk/client"
import CircleCheck from "lucide-solid/icons/circle-check"
import FileCode from "lucide-solid/icons/file-code"
import { createSignal, For, Show } from "solid-js"
import { t } from "../../i18n"
import { isSeen } from "./state"

/** File list for the full review, with a path search above it */
export function ReviewTree(props: { files: ReviewFile[]; activeFile?: string; onOpen: (file: ReviewFile) => void }) {
  const [query, setQuery] = createSignal("")
  const shown = () => {
    const term = query().trim().toLowerCase()
    if (!term) return props.files
    return props.files.filter((file) => file.file.toLowerCase().includes(term))
  }
  return (
    <div class="review-tree-body">
      <div class="review-tree-search">
        <input
          class="input"
          aria-label={t("review.searchFiles")}
          placeholder={t("review.searchFiles")}
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
      </div>
      <div class="review-tree-list scroll">
        <Show when={shown().length} fallback={<p class="subtle side-empty">{t("review.noFileMatch")}</p>}>
          <For each={shown()}>
            {(file) => (
              <button
                class="rt-file"
                classList={{ on: props.activeFile === file.file }}
                onClick={() => props.onOpen(file)}
              >
                <Show when={isSeen(file)} fallback={<FileCode class="icon icon-sm subtle" />}>
                  <CircleCheck class="icon icon-sm add" />
                </Show>
                <span class="name ellipsis">{file.file}</span>
                <span class="hunks">{t("review.hunks", { count: file.hunks })}</span>
              </button>
            )}
          </For>
        </Show>
      </div>
    </div>
  )
}
