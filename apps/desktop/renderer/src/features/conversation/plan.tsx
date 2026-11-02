import { createResource, createSignal, onCleanup, Show, For } from "solid-js"
import type { SessionPlan } from "@merakcode/sdk/client"
import { t } from "../../i18n"
import { call, client } from "../../state/client"
import { listen } from "../../state/store"
import { openPlanInCode } from "../../state/ui"
import { openPanel } from "../panel/workspace"
import { Markdown } from "../../ui/markdown"
import { toast } from "../../ui/toast"
import { buffersFor } from "../code/state"
import { choice } from "../../state/models"

export function usePlan(sessionID: () => string | undefined, directory: () => string) {
  const [plan, { mutate, refetch }] = createResource(sessionID, (sessionID) =>
    call(client(directory()).session.planGet({ sessionID })).catch(() => undefined),
  )
  onCleanup(
    listen((_directory, event) => {
      if (event.type === "session.plan.updated" && event.properties.sessionID === (plan()?.sessionID ?? sessionID()))
        mutate(event.properties)
    }),
  )
  return { plan, refetch }
}

/** The card keeps the first successful submission's server-owned message identity. */
export function PlanCard(props: { sessionID: string; directory: string; plan?: SessionPlan }) {
  const resource = usePlan(
    () => (props.plan ? undefined : props.sessionID),
    () => props.directory,
  )
  const plan = () => props.plan ?? resource.plan()
  const [busy, setBusy] = createSignal(false)
  const active = () => plan()?.queued || plan()?.status === "executing"
  const run = async (action: "start" | "revise") => {
    setBusy(true)
    try {
      if (action === "start") {
        if (!(await buffersFor(props.directory).savePlan(props.sessionID))) throw new Error(t("plan.saveFirst"))
        const selected = choice(props.sessionID, props.directory)
        await call(
          client(props.directory).session.planStart({
            sessionID: props.sessionID,
            model: selected.model,
            variant: selected.variant,
          }),
        )
      } else {
        await call(client(props.directory).session.planRevise({ sessionID: props.sessionID }))
        document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus()
      }
      await resource.refetch()
    } catch (error) {
      toast({ kind: "error", title: t("error.request", { message: (error as Error).message }), error })
    } finally {
      setBusy(false)
    }
  }
  const view = () => {
    void openPanel({ kind: "plan" }, true)
    void call(client(props.directory).session.planView({ sessionID: props.sessionID })).catch((error) =>
      toast({ kind: "error", title: t("error.request", { message: (error as Error).message }), error }),
    )
  }
  const actions = () => (
    <>
      <button class="button secondary sm" onClick={view}>
        {t("plan.view")}
      </button>
      <button
        class="button primary sm"
        disabled={busy() || (plan()?.buttonLocked && !active())}
        onClick={() => (active() ? view() : void run("start"))}
      >
        {t(active() ? "plan.progress" : plan()?.status === "paused" ? "plan.resume" : "plan.start")}
      </button>
      <button class="button ghost sm" disabled={busy() || active()} onClick={() => void run("revise")}>
        {t("plan.revise")}
      </button>
    </>
  )
  return (
    <Show when={plan()?.content && plan()?.anchorMessageID}>
      <section class="plan-card" data-anchor-message-id={plan()?.anchorMessageID} aria-label={t("panel.plan")}>
        <strong>{t("plan.generated")}</strong>
        <p class="subtle">
          {plan()?.status === "paused"
            ? t("plan.paused")
            : plan()?.queued
              ? t("plan.queued")
              : plan()?.status === "executing"
                ? t("plan.fixed")
                : plan()?.status === "review"
                  ? t("plan.pending")
                  : t("plan.draft")}
        </p>
        <div class="row">{actions()}</div>
      </section>
    </Show>
  )
}

/** The plan tab renders the full Markdown and uses the existing editor for human edits. */
export function PlanPanel(props: { sessionID: string; directory: string }) {
  const resource = usePlan(
    () => props.sessionID,
    () => props.directory,
  )
  const [busy, setBusy] = createSignal(false)
  const active = () => resource.plan()?.queued || resource.plan()?.status === "executing"
  const edit = () => {
    openPlanInCode(props.sessionID)
    void call(client(props.directory).session.planView({ sessionID: props.sessionID })).catch((error) =>
      toast({ kind: "error", title: t("error.request", { message: (error as Error).message }), error }),
    )
  }
  const run = async (action: "start" | "adopt") => {
    if (busy()) return
    setBusy(true)
    try {
      if (action === "start") {
        if (active()) {
          document.querySelector(".working")?.scrollIntoView({ block: "nearest" })
          return
        }
        if (!(await buffersFor(props.directory).savePlan(props.sessionID))) throw new Error(t("plan.saveFirst"))
        const selected = choice(props.sessionID, props.directory)
        await call(
          client(props.directory).session.planStart({
            sessionID: props.sessionID,
            model: selected.model,
            variant: selected.variant,
          }),
        )
      } else {
        const candidate = resource.plan()?.candidate
        if (!candidate) return
        await call(client(props.directory).session.planAdopt({ sessionID: props.sessionID, candidateID: candidate.id }))
      }
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
            <button class="button secondary sm" onClick={edit}>
              {t("plan.edit")}
            </button>
            <button
              class="button primary sm"
              disabled={busy() || (resource.plan()?.buttonLocked && !active())}
              onClick={() => void run("start")}
            >
              {t(active() ? "plan.progress" : resource.plan()?.status === "paused" ? "plan.resume" : "plan.start")}
            </button>
          </div>
        </div>
        <div class="plan-scroll">
          <Show when={resource.plan()?.status === "paused"}>
            <p class="subtle">{t("plan.paused")}</p>
          </Show>
          <Show when={resource.plan()?.queued}>
            <p class="subtle">{t("plan.queued")}</p>
          </Show>
          <Show when={resource.plan()?.execution && resource.plan()?.status === "executing"}>
            <p class="subtle">{t("plan.fixed")}</p>
          </Show>
          <Markdown text={resource.plan()?.content ?? ""} />
          <Show when={resource.plan()?.candidate}>
            {(candidate) => (
              <section class="plan-candidate">
                <p>
                  {t("plan.candidateTokens", {
                    before: candidate().originalTokens,
                    after: candidate().candidateTokens,
                  })}
                </p>
                <p class="subtle">{t("plan.candidateCheck")}</p>
                <Markdown text={candidate().content} />
                <For each={candidate().changes}>
                  {(change) => (
                    <pre class="selectable" data-change={change.type}>
                      {change.type === "delete" ? "− " : change.type === "insert" ? "+ " : "  "}
                      {change.text}
                    </pre>
                  )}
                </For>
                <button class="button secondary sm" disabled={busy()} onClick={() => void run("adopt")}>
                  {t("plan.adopt")}
                </button>
              </section>
            )}
          </Show>
        </div>
      </Show>
    </section>
  )
}
