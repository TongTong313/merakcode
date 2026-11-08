import LoaderCircle from "lucide-solid/icons/loader-circle"
import { Show } from "solid-js"
import { t } from "../../i18n"
import type { ReviewData } from "./review"

export function ReviewToolbar(props: { data: ReviewData; sessionID?: string }) {
  return (
    <div class="review-toolbar" role="toolbar" aria-label={t("review.toolbar")}>
      <span>{t("review.scope.session")}</span>
      <button class="button ghost sm" onClick={() => void props.data.refetch()}>
        {t("git.refresh")}
      </button>
      <Show when={props.data.refreshing()}>
        <LoaderCircle class="icon icon-xs spinner muted" role="status" aria-label={t("review.refreshing")} />
      </Show>
    </div>
  )
}
