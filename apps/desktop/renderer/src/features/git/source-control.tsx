import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { t, type Key } from "../../i18n"
import RefreshCw from "lucide-solid/icons/refresh-cw"
import { openReview, usePendingReview } from "../review/state"
import { BranchPicker } from "./branch-picker"
import { Commit } from "./commit"
import { panels } from "../panel/workspace"
import { useGitChanges, type GitChangeFile, type GitChangesResult } from "./changes"

type Action = "stage" | "unstage"

const statusKeys: Record<string, Key> = {
  modified: "git.status.modified",
  added: "git.status.added",
  untracked: "git.status.untracked",
  deleted: "git.status.deleted",
  renamed: "git.status.renamed",
  conflicted: "git.status.conflicted",
}

/** Git file metadata and index actions; code navigation is supplied by the owning panel. */
export function GitFiles(props: {
  directory?: string
  instanceID?: string
  data: GitChangesResult
  pending: string[]
  working: boolean
  onChange: (action: Action, files: GitChangeFile[]) => Promise<void>
  onReview: (file: string) => void
}) {
  const owner = panels()
  const stored = owner?.view(props.instanceID ?? "")
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
  const [view, updateView] = createStore({ selected: strings(stored?.selected), closed: strings(stored?.closed) })
  const setView = (value: typeof view) => {
    updateView(value)
    if (props.instanceID) void owner?.patchView(props.instanceID, value)
  }
  const choose = (id: string, checked: boolean) =>
    setView({
      ...view,
      selected: checked ? [...view.selected, id] : view.selected.filter((value) => value !== id),
    })
  return (
    <div class="git-files scroll">
      <For each={["staged", "unstaged"] as const}>
        {(group) => {
          const files = () => props.data[group]
          const action: Action = group === "staged" ? "unstage" : "stage"
          const selected = () => files().filter((file) => view.selected.includes(`${group}:${file.file}`))
          return (
            <details
              data-group={group}
              class="git-group"
              open={!view.closed.includes(group)}
              onToggle={(event) => {
                const closed = event.currentTarget.open
                  ? view.closed.filter((value) => value !== group)
                  : [...new Set([...view.closed, group])]
                setView({ ...view, closed })
              }}
            >
              <summary>
                <span>{t(`git.${group}`)}</span>
                <span class="count">{files().length}</span>
              </summary>
              <div class="git-group-actions row">
                <Show when={selected().length}>
                  <button
                    class="button secondary sm"
                    disabled={props.working}
                    onClick={() => void props.onChange(action, selected())}
                  >
                    {t(`git.${action}Selected`, { count: selected().length })}
                  </button>
                </Show>
                <button
                  class="button ghost sm"
                  disabled={props.working || !files().length}
                  onClick={() => void props.onChange(action, files())}
                >
                  {t(`git.${action}All`)}
                </button>
              </div>
              <Show when={!files().length}>
                <p class="subtle git-empty">{t("git.noChanges")}</p>
              </Show>
              <For each={files()}>
                {(file) => (
                  <div class="git-file" data-file={file.file}>
                    <input
                      type="checkbox"
                      aria-label={t("git.selectFile", { file: file.file })}
                      checked={view.selected.includes(`${group}:${file.file}`)}
                      disabled={props.working}
                      onChange={(event) => choose(`${group}:${file.file}`, event.currentTarget.checked)}
                    />
                    <Show
                      when={props.pending.includes(file.file)}
                      fallback={
                        <span class="path mono ellipsis" title={file.file}>
                          {file.file}
                        </span>
                      }
                    >
                      <button
                        class="git-review path mono ellipsis"
                        aria-label={t("git.reviewFile", { file: file.file })}
                        title={t("git.reviewFile", { file: file.file })}
                        onClick={() => props.onReview(file.file)}
                      >
                        {file.file}
                      </button>
                    </Show>
                    <span class="badge" title={t(statusKeys[file.status] ?? "git.status.modified")}>
                      {t(statusKeys[file.status] ?? "git.status.modified")}
                    </span>
                    <button
                      class="button ghost sm"
                      aria-label={`${t(`git.${action}`)} ${file.file}`}
                      disabled={props.working}
                      onClick={() => void props.onChange(action, [file])}
                    >
                      {t(`git.${action}`)}
                    </button>
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

export function SourceControl(props: { directory: string; folder: string; sessionID?: string; instanceID?: string }) {
  return (
    <Show when={props.directory} keyed>
      {(directory) => <GitRepository instanceID={props.instanceID} directory={directory} sessionID={props.sessionID} />}
    </Show>
  )
}

function GitRepository(props: { directory: string; sessionID?: string; instanceID?: string }) {
  const data = useGitChanges(() => props.directory)
  const pending = usePendingReview(
    () => props.sessionID,
    () => props.directory,
  )
  return (
    <div class="source-control">
      <div class="git-toolbar row">
        <BranchPicker directory={props.directory} purpose="switch" />
        <span class="spacer" />
        <button
          class="icon-button"
          aria-label={t("git.refresh")}
          disabled={data.loading() || data.working()}
          onClick={() => {
            void data.refresh()
            void pending.refetch()
          }}
        >
          <RefreshCw class="icon icon-sm" />
        </button>
      </div>
      <Show when={data.error()}>
        <p class="git-empty" role="alert">
          {t("git.notRepository")}
        </p>
      </Show>
      <Show
        when={data.data()}
        fallback={
          <p class="git-empty subtle" role="status">
            {t("review.loading")}
          </p>
        }
      >
        {(result) => (
          <>
            <Commit
              instanceID={props.instanceID}
              directory={props.directory}
              pending={result().staged.length > 0}
              working={data.working()}
              onWorkingChange={data.setWorking}
              onDone={async () => {
                await data.refresh()
                await pending.refetch()
              }}
            />
            <GitFiles
              instanceID={props.instanceID}
              directory={props.directory}
              data={result()}
              working={data.working()}
              pending={pending.files()}
              onChange={data.change}
              onReview={(file) => openReview({ scope: "session", file })}
            />
          </>
        )}
      </Show>
    </div>
  )
}
