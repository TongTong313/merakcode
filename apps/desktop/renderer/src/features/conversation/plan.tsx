import { createResource, createSignal, onCleanup, Show } from "solid-js"
import type { PlanPlan } from "@merakcode/sdk"
import { t } from "../../i18n"
import { client } from "../../state/client"
import { MerakCodeError } from "../../state/error"
import { listen } from "../../state/store"
import { openPlanInCode } from "../../state/ui"
import { openPanel } from "../panel/workspace"
import { Markdown } from "../../ui/markdown"
import { toast } from "../../ui/toast"
import { buffersFor } from "../code/state"

/** The plan of a conversation, kept current from the engine's plan events. */
function usePlan(sessionID: () => string | undefined) {
  const [plan, { mutate, refetch }] = createResource(sessionID, (session) =>
    client()
      .then((connection) => connection.plan.get({ session }))
      .catch(() => undefined),
  )
  onCleanup(
    listen((_directory, event) => {
      if (event.type === "plan.updated" && event.payload.session === (plan()?.session ?? sessionID()))
        mutate(event.payload)
    }),
  )
  return { plan, refetch }
}

const running = (plan?: PlanPlan) => plan?.status === "executing"
/** A plan that ran, or is running, is not started again from its card; a stopped one can be. */
const started = (plan?: PlanPlan) => plan?.status === "executing" || plan?.status === "done"

/** The card under the conversation: the plan the agent wrote, with the way to read it, run it or keep editing. */
export function PlanCard(props: { sessionID: string; directory: string }) {
  const resource = usePlan(() => props.sessionID)
  const [busy, setBusy] = createSignal(false)
  const plan = () => resource.plan()
  const run = async () => {
    if (busy() || started(plan())) return
    setBusy(true)
    try {
      if (!(await buffersFor(props.directory).savePlan(props.sessionID)))
        throw new MerakCodeError({ code: "MRK-4027", message: t("plan.saveFirst") })
      await (await client()).plan.execute({ session: props.sessionID })
      await resource.refetch()
    } catch (error) {
      toast({ kind: "error", title: t("error.request", { message: (error as Error).message }), error })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Show when={plan()?.content && plan()?.status !== "draft"}>
      <section class="plan-card" aria-label={t("panel.plan")}>
        <strong>{t("plan.generated")}</strong>
        <p class="subtle">
          {plan()?.status === "executing"
            ? t("plan.fixed")
            : plan()?.status === "review"
              ? t("plan.pending")
              : t("plan.draft")}
        </p>
        <div class="row">
          <button class="button secondary sm" onClick={() => void openPanel({ kind: "plan" }, true)}>
            {t("plan.view")}
          </button>
          <button class="button primary sm" disabled={busy() || started(plan())} onClick={() => void run()}>
            {t("plan.start")}
          </button>
          <button
            class="button ghost sm"
            disabled={busy() || running(plan())}
            onClick={() => document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus()}
          >
            {t("plan.revise")}
          </button>
        </div>
      </section>
    </Show>
  )
}

/** The plan tab renders the full Markdown and uses the existing editor for human edits. */
export function PlanPanel(props: { sessionID: string; directory: string }) {
  const resource = usePlan(() => props.sessionID)
  const [busy, setBusy] = createSignal(false)
  const start = async () => {
    if (busy()) return
    if (running(resource.plan())) {
      document.querySelector(".working")?.scrollIntoView({ block: "nearest" })
      return
    }
    setBusy(true)
    try {
      if (!(await buffersFor(props.directory).savePlan(props.sessionID)))
        throw new MerakCodeError({ code: "MRK-4027", message: t("plan.saveFirst") })
      await (await client()).plan.execute({ session: props.sessionID })
      await resource.refetch()
    } catch (error) {
      toast({ kind: "error", title: t("error.request", { message: (error as Error).message }), error })
    } finally {
      setBusy(false)
    }
  }
  return (
    <section class="plan-panel">
      <Show when={resource.plan()?.content} fallback={<p class="muted">{t("plan.empty")}</p>}>
        <div class="plan-toolbar">
          <strong>{t("panel.plan")}</strong>
          <div class="plan-toolbar-actions">
            <button class="button secondary sm" onClick={() => openPlanInCode(props.sessionID)}>
              {t("plan.edit")}
            </button>
            <button class="button primary sm" disabled={busy()} onClick={() => void start()}>
              {t(running(resource.plan()) ? "plan.progress" : "plan.start")}
            </button>
          </div>
        </div>
        <div class="plan-scroll">
          <Show when={running(resource.plan())}>
            <p class="subtle">{t("plan.fixed")}</p>
          </Show>
          <Markdown text={resource.plan()?.content ?? ""} />
        </div>
      </Show>
    </section>
  )
}
