import { createEffect, createResource, createSignal, onCleanup, Show } from "solid-js"
import { t } from "../../i18n"
import { call, client } from "../../state/client"
import { listen } from "../../state/store"
import { openPlanInCode } from "../../state/ui"
import { Dialog } from "../../ui/dialog"
import { toast } from "../../ui/toast"
import { buffersFor } from "../code/state"

/** The same single plan is reachable from its conversation card and the side panel. */
export function PlanCard(props: { sessionID: string; directory: string; reviewDialog?: boolean }) {
  const [plan, { mutate, refetch }] = createResource(
    () => props.sessionID,
    (sessionID) => call(client(props.directory).session.planGet({ sessionID })),
  )
  const [open, setOpen] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  let shown: string | undefined
  createEffect(() => {
    if (plan()?.status === "draft") shown = undefined
    if (props.reviewDialog && plan()?.status === "review" && shown !== props.sessionID) {
      shown = props.sessionID
      setOpen(true)
    }
  })
  onCleanup(
    listen((_directory, event) => {
      if (
        event.type === "session.plan.updated" &&
        event.properties.sessionID === (plan()?.sessionID ?? props.sessionID)
      )
        mutate(event.properties)
    }),
  )
  const run = async (action: "start" | "revise") => {
    setBusy(true)
    try {
      if (action === "start") {
        if (!(await buffersFor(props.directory).savePlan(props.sessionID))) throw new Error(t("plan.saveFirst"))
        await call(client(props.directory).session.planStart({ sessionID: props.sessionID }))
      } else {
        await call(client(props.directory).session.planRevise({ sessionID: props.sessionID }))
        document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus()
      }
      setOpen(false)
      await refetch()
    } catch (error) {
      toast({ kind: "error", title: t("error.request", { message: (error as Error).message }), error })
    } finally {
      setBusy(false)
    }
  }
  const view = () => {
    setOpen(false)
    openPlanInCode(plan()?.sessionID ?? props.sessionID)
  }
  const actions = () => (
    <>
      <button class="button secondary sm" onClick={view}>
        {t("plan.view")}
      </button>
      <button
        class="button primary sm"
        disabled={busy() || plan()?.status === "executing"}
        onClick={() => void run("start")}
      >
        {t("plan.start")}
      </button>
      <button
        class="button ghost sm"
        disabled={busy() || plan()?.status === "executing"}
        onClick={() => void run("revise")}
      >
        {t("plan.revise")}
      </button>
    </>
  )
  return (
    <Show when={plan()?.content}>
      <section class="plan-card" aria-label={t("panel.plan")}>
        <strong>{t("plan.generated")}</strong>
        <p class="subtle">
          {plan()?.status === "executing"
            ? t("plan.fixed")
            : plan()?.status === "review"
              ? t("plan.pending")
              : t("plan.draft")}
        </p>
        <div class="row">{actions()}</div>
      </section>
      <Dialog
        open={open()}
        onOpenChange={setOpen}
        title={t("plan.generated")}
        description={t("plan.pending")}
        footer={actions()}
      >
        <p>{t("plan.reviewHint")}</p>
      </Dialog>
    </Show>
  )
}
