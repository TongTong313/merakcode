import Undo2 from "lucide-solid/icons/undo-2"
import { Show } from "solid-js"
import { t } from "../../i18n"
import { state } from "../../state/store"
import { toast } from "../../ui/toast"
import { restore } from "./send"

/** Shown after a revert: the hidden messages and files can come back until a new message makes the revert final. */
export function RevertBar(props: { sessionID: string }) {
  const view = () => state.views[props.sessionID]
  return (
    <Show when={view()?.state.hidden && view()?.state.status !== "running"}>
      <div class="revert-bar" role="status">
        <Undo2 class="icon icon-sm" />
        <span class="ellipsis">{t("conversation.reverted")}</span>
        <span class="spacer" />
        <button
          class="button secondary sm"
          onClick={() =>
            void restore(props.sessionID).catch((error: Error) =>
              toast({ kind: "error", title: t("error.request", { message: error.message }), error }),
            )
          }
        >
          {t("conversation.restore")}
        </button>
      </div>
    </Show>
  )
}
