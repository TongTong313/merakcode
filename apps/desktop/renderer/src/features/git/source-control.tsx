import type { GitState } from "@merakcode/sdk"
import { For, Show } from "solid-js"
import RefreshCw from "lucide-solid/icons/refresh-cw"
import { t, type Key } from "../../i18n"
import { openReview } from "../review/state"
import { BranchPicker } from "./branch-picker"
import { useGitChanges } from "./changes"

const statusKeys: Record<string, Key> = {
  modified: "git.status.modified",
  added: "git.status.added",
  untracked: "git.status.untracked",
  deleted: "git.status.deleted",
  renamed: "git.status.renamed",
  conflicted: "git.status.conflicted",
}
export function GitFiles(props: { data: GitState; onReview: (file: string) => void }) {
  return (
    <div class="git-files scroll">
      <For each={[true, false]}>
        {(staged) => {
          const files = () => (props.data.files ?? []).filter((file) => file.staged === staged)
          return (
            <details class="git-group" open>
              <summary>
                <span>{t(staged ? "git.staged" : "git.unstaged")}</span>
                <span class="count">{files().length}</span>
              </summary>
              <Show when={!files().length}>
                <p class="subtle git-empty">{t("git.noChanges")}</p>
              </Show>
              <For each={files()}>
                {(file) => (
                  <div class="git-file" data-file={file.path}>
                    <button
                      class="git-review path mono ellipsis"
                      aria-label={t("git.reviewFile", { file: file.path })}
                      onClick={() => props.onReview(file.path)}
                    >
                      {file.path}
                    </button>
                    <span class="badge">{t(statusKeys[file.status] ?? "git.status.modified")}</span>
                  </div>
                )}
              </For>
            </details>
          )
        }}
      </For>
    </div>
  )
}
export function SourceControl(props: { directory: string; folder: string; sessionID?: string }) {
  const data = useGitChanges(() => props.directory)
  return (
    <div class="source-control">
      <div class="git-toolbar row">
        <BranchPicker directory={props.directory} purpose="switch" />
        <span class="spacer" />
        <button
          class="icon-button"
          aria-label={t("git.refresh")}
          disabled={data.loading()}
          onClick={() => void data.refresh()}
        >
          <RefreshCw class="icon icon-sm" />
        </button>
      </div>
      <Show when={data.error()}>
        <p class="git-empty" role="alert">
          {t("git.notRepository")}
        </p>
      </Show>
      <Show when={data.data()}>
        {(result) => <GitFiles data={result()} onReview={(file) => openReview({ file })} />}
      </Show>
      <Show when={data.loading() && !data.data()}>
        <p class="git-empty subtle" role="status">
          {t("review.loading")}
        </p>
      </Show>
    </div>
  )
}
