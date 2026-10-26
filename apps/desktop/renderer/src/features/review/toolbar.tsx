import LoaderCircle from "lucide-solid/icons/loader-circle"
import { createEffect, on, Show } from "solid-js"
import { t } from "../../i18n"
import { gitState, refreshBranches } from "../../state/git"
import { folderOf } from "../../state/store"
import { Segmented } from "../../ui/segmented"
import { BranchPicker } from "../git/branch-picker"
import type { ReviewData } from "./review"
import { baseFor, prepareBase, progress, review, scopeOptions, selectBase, selectScope } from "./state"

/** Working branch actions sit outside the review scope radiogroup. */
export function ReviewToolbar(props: { folder: string; directory: string; data: ReviewData; sessionID?: string }) {
  const git = () => folderOf(props.folder)?.project?.vcs === "git"
  const count = () => progress(props.data.data())
  createEffect(
    on([git, () => props.directory], ([enabled, directory]) => {
      if (enabled) void refreshBranches(directory)
    }),
  )
  createEffect(() => {
    if (git() && !props.sessionID && (review.scope === "turn" || review.scope === "session")) selectScope("unstaged")
    if (!git() && (review.scope === "unstaged" || review.scope === "staged" || review.scope === "branch"))
      selectScope(props.sessionID ? "session" : "turn")
  })
  createEffect(() => {
    const options = gitState(props.directory)?.options
    if (options)
      prepareBase(
        props.directory,
        options.branches.map((branch) => branch.name),
        options.defaultBranch,
      )
  })
  return (
    <div class="review-toolbar" role="toolbar" aria-label={t("review.toolbar")}>
      <Show when={scopeOptions(git(), !!props.sessionID).length}>
        <Segmented
          label={t("review.scope")}
          options={scopeOptions(git(), !!props.sessionID)}
          value={review.scope}
          onChange={selectScope}
        />
      </Show>
      <Show when={git()}>
        <div class="review-branches">
          <BranchPicker directory={props.directory} purpose="switch" />
          <span class="subtle">{t("git.compare")}</span>
          <BranchPicker
            directory={props.directory}
            purpose="base"
            value={baseFor(props.directory)}
            active={review.scope === "branch"}
            onSelect={(branch) => selectBase(props.directory, branch)}
          />
        </div>
      </Show>
      <Show when={props.data.refreshing()}>
        <LoaderCircle class="icon icon-xs spinner muted" role="status" aria-label={t("review.refreshing")} />
      </Show>
      <Show when={review.scope === "branch" && count().total}>
        <span class="progress">{t("review.progress", count())}</span>
      </Show>
    </div>
  )
}
