import type { GitChangeFile, GitChangesResult } from "@merakcode/sdk/client"
import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { t } from "../../i18n"
import RefreshCw from "lucide-solid/icons/refresh-cw"
import { folderOf } from "../../state/store"
import { openReview, usePendingReview } from "../review/state"
import { BranchPicker } from "./branch-picker"
import { Commit } from "./commit"
import { useGitChanges } from "./changes"

type Action = "stage" | "unstage"
const [views, setViews] = createStore<Record<string, { selected: string[]; closed: string[] }>>({})

/** Git file metadata and index actions; code navigation is supplied by the owning panel. */
export function GitFiles(props: {
  directory?: string
  data: GitChangesResult
  pending: string[]
  working: boolean
  onChange: (action: Action, files: GitChangeFile[]) => Promise<void>
  onReview: (file: string) => void
}) {
  const key = () => props.directory ?? ""
  const view = () => views[key()] ?? { selected: [], closed: [] }
  const choose = (id: string, checked: boolean) =>
    setViews(key(), {
      ...view(),
      selected: checked ? [...view().selected, id] : view().selected.filter((value) => value !== id),
    })
  return (
    <div class="git-files scroll">
      <For each={["staged", "unstaged"] as const}>
        {(group) => {
          const files = () => props.data[group]
          const action: Action = group === "staged" ? "unstage" : "stage"
          const selected = () => files().filter((file) => view().selected.includes(`${group}:${file.file}`))
          return (
            <details
              data-group={group}
              class="git-group"
              open={!view().closed.includes(group)}
              onToggle={(event) => {
                const closed = event.currentTarget.open
                  ? view().closed.filter((value) => value !== group)
                  : [...new Set([...view().closed, group])]
                setViews(key(), { ...view(), closed })
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
                      checked={view().selected.includes(`${group}:${file.file}`)}
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
                    <span class="badge" title={t(`git.status.${file.status}`)}>
                      {t(`git.status.${file.status}`)}
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

export function SourceControl(props: { directory: string; folder: string; sessionID?: string }) {
  const enabled = () => folderOf(props.folder)?.project?.vcs === "git"
  return (
    <Show when={enabled()} fallback={<div class="empty-state subtle">{t("git.notRepository")}</div>}>
      <Show when={props.directory} keyed>
        {(directory) => <GitRepository directory={directory} sessionID={props.sessionID} />}
      </Show>
    </Show>
  )
}

function GitRepository(props: { directory: string; sessionID?: string }) {
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
        {(error) => (
          <p class="git-empty" role="alert">
            {error().message}
          </p>
        )}
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
