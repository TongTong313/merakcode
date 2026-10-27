import { t } from "../../i18n"
import { Dialog } from "../../ui/dialog"
import { createEffect, createSignal, on, Show } from "solid-js"
import { summary } from "../../state/error"

export function TakeoverDialog(props: {
  open: boolean
  productTitle: string
  onDecision: (decision: "accept" | "decline") => Promise<void>
}) {
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  let submitted = false
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return
        submitted = false
        setError(undefined)
      },
    ),
  )
  const decide = async (decision: "accept" | "decline") => {
    if (busy() || submitted) return
    setBusy(true)
    setError(undefined)
    try {
      await props.onDecision(decision)
      submitted = true
    } catch (error) {
      setError([summary(error), error instanceof Error ? error.message : String(error)].filter(Boolean).join(" · "))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => !open && void decide("decline")}
      title={t("conversation.takeover.title")}
      description={t("conversation.takeover.description", { product: props.productTitle })}
      footer={
        <>
          <button class="button secondary" disabled={busy()} onClick={() => void decide("decline")}>
            {t("conversation.takeover.decline")}
          </button>
          <button class="button primary" disabled={busy()} onClick={() => void decide("accept")}>
            {t("conversation.takeover.accept")}
          </button>
        </>
      }
    >
      <Show when={error()}>
        {(message) => (
          <p class="dialog-body form-problem" role="alert">
            {message()}
          </p>
        )}
      </Show>
    </Dialog>
  )
}
