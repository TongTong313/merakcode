import { createEffect, createSignal } from "solid-js"
import { t } from "../../i18n"
import { renameSession, type SessionSummary } from "../../state/store"
import { Dialog } from "../../ui/dialog"
import { toast } from "../../ui/toast"

/** Renames a conversation */
export function Rename(props: { session: SessionSummary; open: boolean; onClose: () => void }) {
  const [title, setTitle] = createSignal("")
  createEffect(() => props.open && setTitle(props.session.title))
  const save = async () => {
    const value = title().trim()
    if (!value) return
    try {
      await renameSession(props.session.id, value)
    } catch (error) {
      toast({
        kind: "error",
        title: t("error.request", { message: error instanceof Error ? error.message : String(error) }),
      })
      return
    }
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
