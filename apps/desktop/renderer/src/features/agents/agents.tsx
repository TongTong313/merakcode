import Copy from "lucide-solid/icons/copy"
import FlaskConical from "lucide-solid/icons/flask-conical"
import Pencil from "lucide-solid/icons/pencil"
import Plus from "lucide-solid/icons/plus"
import Trash2 from "lucide-solid/icons/trash"
import { useSearchParams } from "@solidjs/router"
import { createSignal, For, onMount, Show } from "solid-js"
import type { AgentAgent, WorkerProductInfo } from "@merakcode/sdk"
import { t } from "../../i18n"
import { agents, catalog, catalogLoaded, deleteAgent, loadAgents, loadCatalog, saveAgent } from "../../state/agents"
import { client } from "../../state/client"
import { Confirm } from "../../ui/dialog"
import { Switch } from "../../ui/switch"
import { toast } from "../../ui/toast"
import { Sidebar } from "../shell/sidebar"
import { Row } from "../settings/layout"
import { addedAgent, productDraft } from "./draft"
import { AgentWizard } from "./wizard"

const failed = (error: unknown) => toast({ kind: "error", title: t("error.request", { message: "MRK-4001" }), error })

function ProductCard(props: { product: WorkerProductInfo; added?: AgentAgent; onAdd: () => void; busy: boolean }) {
  const status = () =>
    props.product.available
      ? [t("agents.available"), props.product.version, props.product.binary].filter(Boolean).join(" · ")
      : t("agents.unavailable")
  return (
    <Row label={props.product.name} desc={status()}>
      <Show
        when={props.added}
        fallback={
          <button
            class="button secondary sm"
            aria-label={t("agents.addProduct", { name: props.product.name })}
            disabled={!props.product.available || props.busy}
            onClick={props.onAdd}
          >
            <Plus class="icon icon-sm" />
            {t("agents.add")}
          </button>
        }
      >
        <button class="button ghost sm" aria-label={t("agents.added", { name: props.product.name })} disabled>
          {t("agents.addedShort")}
        </button>
      </Show>
    </Row>
  )
}

function AgentCard(props: {
  agent: AgentAgent
  onEdit: () => void
  onCopy: () => void
  onDelete: () => void
  onEnabled: (enabled: boolean) => void
}) {
  const [testing, setTesting] = createSignal(false)
  const [verified, setVerified] = createSignal(false)
  const builtin = () => props.agent.id.startsWith("builtin-")
  const readonly = () => builtin() || props.agent.id.startsWith("file:") || props.agent.source === "config"
  const test = async () => {
    setTesting(true)
    setVerified(false)
    try {
      await (await client()).agent.test({ agent: props.agent })
      setVerified(true)
    } catch (error) {
      failed(error)
    } finally {
      setTesting(false)
    }
  }
  const harness = () => props.agent.product?.kind ?? "MerakCode"
  const model = () =>
    props.agent.product
      ? props.agent.product.model || t("agents.modelDefault")
      : props.agent.model.provider
        ? `${props.agent.model.provider}/${props.agent.model.model}`
        : t("agents.modelDefault")
  const detail = () => (
    <>
      <span data-harness>{harness()}</span>
      {" · "}
      <span data-model>{model()}</span>
      <Show when={props.agent.summary}>
        {" · "}
        <span>{props.agent.summary}</span>
      </Show>
      <Show when={props.agent.duties}>
        <span class="agent-duties" data-duties>
          {props.agent.duties}
        </span>
      </Show>
    </>
  )
  return (
    <article class="card agent-card" data-agent={props.agent.id}>
      <Row label={props.agent.name} desc={detail()}>
        <Show when={builtin()}>
          <span class="badge neutral">{t("settings.badge.builtin")}</span>
        </Show>
        <Show when={verified()}>
          <span class="subtle" role="status">
            {t("agents.tested")}
          </span>
        </Show>
        <Show when={!readonly() && props.agent.product && props.agent.product.kind !== "remote"}>
          <Switch
            label={t("agents.enable", { name: props.agent.name })}
            hideLabel
            checked={!props.agent.disabled}
            onChange={props.onEnabled}
          />
        </Show>
        <Show when={props.agent.product && props.agent.product.kind !== "remote"}>
          <button
            class="icon-button"
            aria-label={t("agents.test", { name: props.agent.name })}
            title={t("agents.testShort")}
            disabled={testing()}
            onClick={() => void test()}
          >
            <FlaskConical class="icon icon-sm" />
          </button>
        </Show>
        <Show when={props.agent.product?.kind !== "remote"}>
          <button
            class="icon-button"
            aria-label={t("agents.copy", { name: props.agent.name })}
            title={t("common.copy")}
            onClick={props.onCopy}
          >
            <Copy class="icon icon-sm" />
          </button>
        </Show>
        <Show when={!readonly() && props.agent.product?.kind !== "remote"}>
          <button
            class="icon-button"
            aria-label={t("agents.edit", { name: props.agent.name })}
            title={t("common.edit")}
            onClick={props.onEdit}
          >
            <Pencil class="icon icon-sm" />
          </button>
        </Show>
        <Show when={!readonly()}>
          <button
            class="icon-button"
            aria-label={t("agents.delete", { name: props.agent.name })}
            title={t("common.remove")}
            onClick={props.onDelete}
          >
            <Trash2 class="icon icon-sm" />
          </button>
        </Show>
      </Row>
    </article>
  )
}

/** The agents of this person: products found on this machine to add in one click, and the agents to edit. */
export function AgentsPage() {
  const [params, setParams] = useSearchParams()
  const [editing, setEditing] = createSignal<AgentAgent | "new">()
  const [removing, setRemoving] = createSignal<AgentAgent>()
  const [busy, setBusy] = createSignal(false)
  const [checking, setChecking] = createSignal(false)
  const detect = () => {
    setChecking(true)
    void loadCatalog()
      .catch(failed)
      .finally(() => setChecking(false))
  }
  onMount(() => {
    void loadAgents().catch(failed)
    detect()
    if (params.new) {
      setEditing("new")
      setParams({ new: undefined }, { replace: true })
    }
  })
  const add = async (product: WorkerProductInfo) => {
    setBusy(true)
    try {
      await saveAgent(productDraft(product))
    } catch (error) {
      failed(error)
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    const agent = removing()
    setRemoving(undefined)
    if (!agent) return
    try {
      await deleteAgent(agent.id)
    } catch (error) {
      toast({ kind: "error", title: t("error.request", { message: "MRK-4001" }), error })
    }
  }
  return (
    <div class="app">
      <Sidebar />
      <main class="main">
        <div class="topbar drag">
          <span class="title">{t("agents.title")}</span>
          <span class="spacer" />
          <div class="no-drag row">
            <button class="button primary sm" onClick={() => setEditing("new")}>
              <Plus class="icon icon-sm" />
              {t("agents.new")}
            </button>
          </div>
        </div>
        <div class="settings-body scroll">
          <div class="settings-inner">
            <h1>{t("agents.title")}</h1>
            <p class="lead">{t("agents.lead")}</p>
            <div class="section-title">
              {t("agents.detected")}
              <span class="spacer" />
              <button class="button ghost sm" disabled={checking()} onClick={detect}>
                {checking() ? t("agents.checking") : t("agents.refresh")}
              </button>
            </div>
            <div class="card" role="region" aria-label={t("agents.detected")}>
              <Show when={catalogLoaded()} fallback={<p class="subtle">{t("agents.checking")}</p>}>
                <For each={catalog().filter((product) => product.kind !== "builtin")}>
                  {(product) => (
                    <ProductCard
                      product={product}
                      added={addedAgent(agents(), product)}
                      busy={busy()}
                      onAdd={() => void add(product)}
                    />
                  )}
                </For>
              </Show>
            </div>
            <div class="section-title">{t("agents.mine")}</div>
            <div class="agent-list" role="region" aria-label={t("agents.mine")}>
              <Show when={agents().length} fallback={<p class="subtle">{t("agents.empty")}</p>}>
                <For each={agents()}>
                  {(agent) => (
                    <AgentCard
                      agent={agent}
                      onEdit={() => setEditing(agent)}
                      onCopy={() =>
                        setEditing({
                          ...structuredClone(agent),
                          id: "",
                          name: t("agents.copyName", { name: agent.name }),
                          source: undefined,
                        })
                      }
                      onDelete={() => setRemoving(agent)}
                      onEnabled={(enabled) => void saveAgent({ ...agent, disabled: !enabled }).catch(failed)}
                    />
                  )}
                </For>
              </Show>
            </div>
          </div>
        </div>
      </main>
      <AgentWizard
        open={!!editing()}
        agent={editing() === "new" ? undefined : (editing() as AgentAgent | undefined)}
        onClose={() => setEditing(undefined)}
      />
      <Confirm
        open={!!removing()}
        title={t("agents.deleteTitle", { name: removing()?.name ?? "" })}
        description={t("agents.deleteDetail")}
        confirm={t("agents.deleteConfirm")}
        cancel={t("common.cancel")}
        danger
        onResult={(ok) => (ok ? void remove() : setRemoving(undefined))}
      />
    </div>
  )
}
