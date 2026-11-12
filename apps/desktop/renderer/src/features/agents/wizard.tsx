import X from "lucide-solid/icons/x"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import type { AgentAgent } from "@merakcode/sdk"
import { t } from "../../i18n"
import { agents, catalog, saveAgent } from "../../state/agents"
import { client } from "../../state/client"
import { choice } from "../../state/models"
import { Dialog } from "../../ui/dialog"
import { Segmented } from "../../ui/segmented"
import { Select } from "../../ui/select"
import { toast } from "../../ui/toast"
import { ModelPicker } from "../conversation/model-picker"
import { PermissionModeSelect } from "../conversation/permission-mode"
import { envPayload, envProblem, envRows, productsFor, type EnvRow } from "./draft"

const steps = ["product", "connection", "duties", "permissions"] as const
type Step = (typeof steps)[number]

const blank = (): AgentAgent => ({
  id: "",
  name: "",
  role: "worker",
  summary: "",
  duties: "",
  toolPool: "worker.default",
  shared: true,
  model: { provider: "", model: "" },
})

const failed = (error: unknown) => toast({ kind: "error", title: t("error.request", { message: "MRK-4001" }), error })

/** New or edited agent in four steps: the product, its model or command, its duties, and its permissions. */
export function AgentWizard(props: { open: boolean; agent?: AgentAgent; onClose: () => void }) {
  const [step, setStep] = createSignal<Step>("product")
  const [draft, setDraft] = createSignal<AgentAgent>(blank())
  const [env, setEnv] = createSignal<EnvRow[]>([])
  const [picked, setPicked] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [verified, setVerified] = createSignal(false)
  const editing = () => !!props.agent?.id
  const external = () => !!draft().product
  const kind = () => draft().product?.kind ?? "builtin"
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return
        const base = props.agent ? structuredClone(props.agent) : blank()
        setDraft(base)
        setEnv(envRows(base.product?.env))
        setPicked(!!base.model.provider)
        setVerified(false)
        setStep("product")
      },
    ),
  )
  createEffect(
    on(
      () => [draft(), env()],
      () => setVerified(false),
      { defer: true },
    ),
  )
  const patch = (change: Partial<AgentAgent>) => setDraft((agent) => ({ ...agent, ...change }))
  const patchProduct = (change: Partial<NonNullable<AgentAgent["product"]>>) =>
    setDraft((agent) => ({ ...agent, product: { kind: "", binary: "", ...agent.product, ...change } }))
  const setRole = (role: "leader" | "worker") => {
    const allowed = role === "worker" || productsFor("leader", catalog()).some((item) => item.kind === kind())
    setDraft((agent) => ({
      ...agent,
      role,
      toolPool: role === "leader" ? "leader.default" : "worker.default",
      ...(allowed ? {} : { product: undefined }),
    }))
  }
  const setProduct = (value: string) => {
    if (value === "builtin") {
      patch({ product: undefined })
      setEnv([])
      return
    }
    const found = catalog().find((item) => item.kind === value)
    patch({ product: { kind: value, binary: found?.binary ?? "", args: [] }, model: { provider: "", model: "" } })
    setEnv([])
  }
  const fromTemplate = (id: string) => {
    const source = agents().find((agent) => agent.id === id)
    if (!source) return
    setDraft((agent) => ({
      ...agent,
      summary: source.summary,
      duties: source.duties,
      system: source.system,
      mode: source.mode,
    }))
  }
  const model = () => {
    const selected = draft().model
    if (picked() && selected.provider) return { providerID: selected.provider, modelID: selected.model }
    return choice(undefined, "").model
  }
  const problem = () => envProblem(env())
  const payload = (): AgentAgent => {
    const agent = draft()
    const base = { ...agent, name: agent.name.trim(), summary: agent.summary.trim() }
    if (!agent.product) return { ...base, product: undefined, network: undefined }
    return { ...base, product: { ...agent.product, env: envPayload(env()) } }
  }
  const valid = () =>
    !!draft().name.trim() && !problem() && (!external() || !!draft().product!.binary.trim()) && !busy()
  const canTest = () => external() && !problem() && !!draft().product!.binary.trim()
  const index = () => steps.indexOf(step())
  const test = async () => {
    setBusy(true)
    try {
      // The name is asked for later; the check only needs a name that is not empty
      await (await client()).agent.test({ agent: { ...payload(), name: payload().name || draft().product!.kind } })
      setVerified(true)
    } catch (error) {
      failed(error)
    } finally {
      setBusy(false)
    }
  }
  const save = async () => {
    if (!valid()) return
    setBusy(true)
    try {
      await saveAgent(payload())
      props.onClose()
    } catch (error) {
      failed(error)
    } finally {
      setBusy(false)
    }
  }
  const productOptions = createMemo(() => [
    { value: "builtin", label: t("agents.product.builtin") },
    ...productsFor(draft().role, catalog()).map((item) => ({ value: item.kind, label: item.name })),
    ...(draft().role === "worker"
      ? [
          { value: "acp", label: t("agents.product.acp") },
          { value: "command", label: t("agents.product.command") },
        ]
      : []),
  ])
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => !open && props.onClose()}
      title={props.agent?.id ? t("agents.wizard.edit", { name: props.agent.name }) : t("agents.wizard.new")}
      class="agent-wizard"
      footer={
        <>
          <button class="button secondary" disabled={busy()} onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <Show when={index() > 0}>
            <button class="button secondary" disabled={busy()} onClick={() => setStep(steps[index() - 1]!)}>
              {t("agents.step.back")}
            </button>
          </Show>
          <Show
            when={index() < steps.length - 1}
            fallback={
              <button class="button primary" disabled={!valid()} onClick={() => void save()}>
                {t("agents.save")}
              </button>
            }
          >
            <button class="button primary" disabled={busy()} onClick={() => setStep(steps[index() + 1]!)}>
              {t("agents.step.next")}
            </button>
          </Show>
        </>
      }
    >
      <div class="dialog-body form">
        <p class="subtle wizard-steps" aria-live="polite">
          {index() + 1} / {steps.length} · {t(`agents.step.${step()}`)}
        </p>
        <Show when={step() === "product"}>
          <div class="field">
            <span>{t("agents.role")}</span>
            <Segmented
              label={t("agents.role")}
              value={draft().role as "leader" | "worker"}
              onChange={setRole}
              options={[
                { value: "worker", label: t("agents.role.worker") },
                { value: "leader", label: t("agents.role.leader"), hint: t("agents.role.leaderHint") },
              ]}
            />
          </div>
          <div class="field">
            <span>{t("agents.product")}</span>
            <Segmented label={t("agents.product")} value={kind()} onChange={setProduct} options={productOptions()} />
          </div>
        </Show>
        <Show when={step() === "connection"}>
          <Show
            when={external()}
            fallback={
              <div class="field">
                <span>{t("agents.model")}</span>
                <div class="row">
                  <ModelPicker
                    value={model()}
                    onChange={(selected) => {
                      setPicked(true)
                      patch({ model: { ...draft().model, provider: selected.providerID, model: selected.modelID } })
                    }}
                  />
                </div>
                <p class="subtle">{t("agents.model.default")}</p>
              </div>
            }
          >
            <label class="field">
              <span>{t("settings.collaboration.command")}</span>
              <input
                class="input mono"
                aria-label={t("settings.collaboration.command")}
                value={draft().product?.binary ?? ""}
                onInput={(event) => patchProduct({ binary: event.currentTarget.value })}
              />
            </label>
            <label class="field">
              <span>{t("settings.collaboration.args")}</span>
              <textarea
                class="input mono"
                aria-label={t("settings.collaboration.args")}
                rows={3}
                value={(draft().product?.args ?? []).join("\n")}
                onInput={(event) =>
                  patchProduct({
                    args: event.currentTarget.value
                      .split(/\r?\n/)
                      .map((line) => line.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
            <label class="field">
              <span>{t("agents.productModel")}</span>
              <input
                class="input mono"
                aria-label={t("agents.productModel")}
                value={draft().product?.model ?? ""}
                onInput={(event) => patchProduct({ model: event.currentTarget.value })}
              />
            </label>
            <div class="field">
              <span>{t("agents.env")}</span>
              <For each={env()}>
                {(row, position) => (
                  <div class="row env-row">
                    <input
                      class="input mono"
                      aria-label={t("agents.env.name")}
                      value={row.name}
                      onInput={(event) =>
                        setEnv((rows) =>
                          rows.map((item, at) =>
                            at === position() ? { ...item, name: event.currentTarget.value } : item,
                          ),
                        )
                      }
                    />
                    <input
                      class="input mono"
                      type="password"
                      autocomplete="off"
                      aria-label={t("agents.env.value")}
                      placeholder={row.saved ? t("agents.env.saved") : undefined}
                      value={row.value}
                      onInput={(event) =>
                        setEnv((rows) =>
                          rows.map((item, at) =>
                            at === position() ? { ...item, value: event.currentTarget.value } : item,
                          ),
                        )
                      }
                    />
                    <button
                      type="button"
                      class="icon-button sm"
                      aria-label={t("agents.env.remove")}
                      onClick={() => setEnv((rows) => rows.filter((_, at) => at !== position()))}
                    >
                      <X class="icon icon-xs" />
                    </button>
                  </div>
                )}
              </For>
              <Show when={problem()}>
                {(reason) => (
                  <p class="form-problem" role="status">
                    {t(`agents.env.${reason()}`)}
                  </p>
                )}
              </Show>
              <div class="row">
                <button
                  type="button"
                  class="button ghost sm"
                  onClick={() => setEnv((rows) => [...rows, { name: "", value: "", saved: false }])}
                >
                  {t("agents.env.add")}
                </button>
                <button
                  type="button"
                  class="button ghost sm"
                  disabled={busy() || !canTest()}
                  onClick={() => void test()}
                >
                  {t("agents.testShort")}
                </button>
                <Show when={verified()}>
                  <span class="subtle" role="status">
                    {t("agents.tested")}
                  </span>
                </Show>
              </div>
            </div>
          </Show>
        </Show>
        <Show when={step() === "duties"}>
          <Show when={!editing() && agents().length}>
            <div class="field">
              <span>{t("agents.template")}</span>
              <Select
                class="chip outlined"
                label={t("agents.template")}
                value={undefined}
                placeholder={t("agents.templatePlaceholder")}
                options={agents().map((agent) => ({ value: agent.id, label: agent.name, description: agent.summary }))}
                onChange={fromTemplate}
              />
            </div>
          </Show>
          <label class="field">
            <span>{t("agents.name")}</span>
            <input
              class="input"
              aria-label={t("agents.name")}
              value={draft().name}
              onInput={(event) => patch({ name: event.currentTarget.value })}
            />
          </label>
          <label class="field">
            <span>{t("agents.summary")}</span>
            <input
              class="input"
              aria-label={t("agents.summary")}
              value={draft().summary}
              onInput={(event) => patch({ summary: event.currentTarget.value })}
            />
          </label>
          <label class="field">
            <span>{t("agents.duties")}</span>
            <textarea
              class="input"
              aria-label={t("agents.duties")}
              rows={4}
              value={draft().duties}
              onInput={(event) => patch({ duties: event.currentTarget.value })}
            />
          </label>
          <label class="field">
            <span>{t("agents.system")}</span>
            <textarea
              class="input"
              aria-label={t("agents.system")}
              rows={3}
              value={draft().system ?? ""}
              onInput={(event) => patch({ system: event.currentTarget.value })}
            />
          </label>
        </Show>
        <Show when={step() === "permissions"}>
          <div class="field">
            <span>{t("agents.mode")}</span>
            <div class="row">
              <PermissionModeSelect value={draft().mode || "ask"} onChange={(mode) => patch({ mode })} />
            </div>
          </div>
          <Show when={external()}>
            <label class="field">
              <span>{t("agents.network")}</span>
              <textarea
                class="input mono"
                aria-label={t("agents.network")}
                rows={3}
                value={(draft().network ?? []).join("\n")}
                onInput={(event) =>
                  patch({
                    network: event.currentTarget.value
                      .split(/\r?\n/)
                      .map((host) => host.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
          </Show>
        </Show>
      </div>
    </Dialog>
  )
}
