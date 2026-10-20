import type { Session } from "@merakcode/sdk/client"
import { createEffect, createSignal } from "solid-js"
import { t } from "../../i18n"
import { call, client } from "../../state/client"
import { Dialog } from "../../ui/dialog"
import { toast } from "../../ui/toast"

/** Renames a conversation */
export function Rename(props: { session: Session; open: boolean; onClose: () => void }) {
  const [title, setTitle] = createSignal("")
  createEffect(() => props.open && setTitle(props.session.title))
  const save = async () => {
    const value = title().trim()
    if (!value) return
    await call(client(props.session.directory).session.update({ sessionID: props.session.id, title: value })).catch(
      (error: Error) => toast({ kind: "error", title: t("error.request", { message: error.message }), error: error }),
    )
    props.onClose()
  }
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => !open && props.onClose()}
      title={t("sidebar.renameTitle")}
      footer={
        <>
          <button class="button secondary" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button class="button primary" disabled={!title().trim()} onClick={() => void save()}>
            {t("common.save")}
          </button>
        </>
      }
    >
      <div class="dialog-body form">
        <input
          class="input"
          aria-label={t("sidebar.renameTitle")}
          value={title()}
          onInput={(event) => setTitle(event.currentTarget.value)}
          onKeyDown={(event) => event.key === "Enter" && !event.isComposing && void save()}
          autofocus
        />
      </div>
    </Dialog>
  )
}
