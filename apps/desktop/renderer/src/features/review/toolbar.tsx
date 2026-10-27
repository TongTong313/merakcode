import LoaderCircle from "lucide-solid/icons/loader-circle"
import { Show } from "solid-js"
import { t } from "../../i18n"
import { Segmented } from "../../ui/segmented"
import type { ReviewData } from "./review"
import { review, scopeOptions, selectScope } from "./state"

export function ReviewToolbar(props: { data: ReviewData; sessionID?: string }) {
  return (
    <div class="review-toolbar" role="toolbar" aria-label={t("review.toolbar")}>
      <Show when={props.sessionID}>
        <Segmented label={t("review.scope")} options={scopeOptions()} value={review.scope} onChange={selectScope} />
      </Show>
      <Show when={props.data.refreshing()}>
        <LoaderCircle class="icon icon-xs spinner muted" role="status" aria-label={t("review.refreshing")} />
      </Show>
    </div>
  )
}
