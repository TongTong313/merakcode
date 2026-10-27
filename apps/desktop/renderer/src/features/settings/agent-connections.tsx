import type {
  AgentConnectionModels,
  AgentConnectionProduct,
  AgentConnectionProductChangeData,
  AgentConnectionVerification,
} from "@merakcode/sdk/client"
import Pencil from "lucide-solid/icons/pencil"
import Plus from "lucide-solid/icons/plus"
import Sparkles from "lucide-solid/icons/sparkles"
import RotateCcw from "lucide-solid/icons/rotate-ccw"
import Trash2 from "lucide-solid/icons/trash"
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js"
import { t } from "../../i18n"
import { Select } from "../../ui/select"
import { Switch } from "../../ui/switch"
import { call, client } from "../../state/client"
import { state } from "../../state/store"
import { summary } from "../../state/error"
import { toast } from "../../ui/toast"
import { useNavigate } from "@solidjs/router"
import { sessionPath } from "../../lib/route"
import { choiceKey } from "../../state/models"
import { setUi } from "../../state/ui"
import { fill } from "../conversation/composer"
import { Row, Section } from "./layout"
import { agentConnections, loadConnections, refreshConnections, changeConnection } from "../../state/agent-connections"
import { onMount } from "solid-js"

type Product = AgentConnectionProduct
type ProductChange = AgentConnectionProductChangeData["body"]
type Adapter = "command" | "member" | "claude" | "codex" | "opencode"

/**
 * Under a product's name: whether it runs, with the version and path found, or why not, and who decides its
 * permissions, as reported by the installed adapter.
 */
function status(product: Product) {
  if (product.id === "merak") return t("settings.agentConnections.builtin")
  const upgrade = product.outdated
    ? t("settings.collaboration.upgrade", { recommended: product.recommended ?? "", command: product.upgrade ?? "" })
    : undefined
  const runs = product.connected
    ? [t("settings.collaboration.available"), product.version, upgrade, product.path]
    : [t("group.unavailable"), product.reason]
  const permission =
    product.connected &&
    (product.capabilities.permission === "merak"
      ? t("settings.collaboration.permission.merak")
      : t("settings.collaboration.permission.own"))
  return [
    product.enabled ? undefined : t("settings.collaboration.off"),
    ...runs,
    permission,
    product.connected && !product.capabilities.textStreaming ? t("conversation.outputOnCompletion") : undefined,
  ]
    .filter(Boolean)
    .join(" · ")
}

/** Built-in defaults and global overrides. */
function badges(product: Product) {
  if (product.id === "merak") return []
  if (!product.builtin) return [t("settings.collaboration.custom")]
  return product.source === "global"
    ? [t("settings.badge.builtin"), t("settings.collaboration.changed")]
    : [t("settings.badge.builtin")]
}

/** How a custom product is driven: one-shot, an adapter of the user's own, or a built-in adapter for that CLI */
const adapters = (): { value: Adapter; label: string }[] => [
  { value: "command", label: t("settings.collaboration.adapter.command") },
  { value: "member", label: t("settings.collaboration.adapter.member") },
  { value: "claude", label: t("settings.collaboration.adapter.claude") },
  { value: "codex", label: t("settings.collaboration.adapter.codex") },
  { value: "opencode", label: t("settings.collaboration.adapter.opencode") },
]

/** Non-empty lines; nothing written counts as left out */
const lines = (text: string) => {
  const items = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  return items.length ? items : undefined
}

/** What keeps the form from being saved, or undefined when nothing does */
function formProblem(input: { id: string; taken: readonly string[]; command: string; sessionLine: string }) {
  const id = input.id.trim()
  if (!id) return t("settings.collaboration.idEmpty")
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return t("settings.collaboration.idInvalid")
  if (id === "merak" || input.taken.includes(id)) return t("settings.collaboration.idTaken")
  if (!input.command.trim()) return t("settings.collaboration.commandEmpty")
  try {
    new RegExp(input.sessionLine)
  } catch {
    return t("settings.collaboration.sessionLineInvalid")
  }
}

/** A product's global connection fields. */
function ProductForm(props: {
  /** The product edited; without one the form adds a product and asks for its id */
  product?: Product
  /** Ids already in use */
  taken: readonly string[]
  onModels?: (productID: string) => Promise<AgentConnectionModels>
  onSave: (id: string, product: Extract<ProductChange, { type: "add" }>["product"]) => void
  onCancel: () => void
}) {
  const [id, setId] = createSignal(props.product?.id ?? "")
  const [title, setTitle] = createSignal(props.product?.title ?? "")
  const [command, setCommand] = createSignal(props.product?.command ?? "")
  const [adapter, setAdapter] = createSignal((props.product?.adapter ?? "command") as Adapter)
  // A built-in product is driven by its own adapter: only the command and extra arguments are the user's
  const builtin = () => !!props.product?.builtin
  const oneShot = () => !builtin() && adapter() === "command"
  const [args, setArgs] = createSignal(props.product?.args?.join("\n") ?? "")
  const [resumeArgs, setResumeArgs] = createSignal(props.product?.resumeArgs?.join("\n") ?? "")
  const [sessionLine, setSessionLine] = createSignal(props.product?.sessionLine ?? "")
  const [model, setModel] = createSignal(props.product?.model?.id ?? "")
  const [provider, setProvider] = createSignal(props.product?.model?.providerID ?? "")
  const [models, setModels] = createSignal<AgentConnectionModels>()
  const [modelsLoading, setModelsLoading] = createSignal(false)
  const [modelsError, setModelsError] = createSignal<string>()
  const discover = async () => {
    if (!props.product || !props.onModels || modelsLoading()) return
    setModelsLoading(true)
    setModelsError(undefined)
    try {
      setModels(await props.onModels(props.product.id))
    } catch (error) {
      setModelsError(
        [summary(error), error instanceof Error ? error.message : String(error)].filter(Boolean).join(" · "),
      )
    } finally {
      setModelsLoading(false)
    }
  }
  const problem = () =>
    formProblem({
      id: id(),
      taken: props.product ? [] : props.taken,
      command: command(),
      sessionLine: oneShot() ? sessionLine() : "",
    })
  const save = () => {
    const shared = {
      title: title().trim() || undefined,
      command: command().trim(),
      args: lines(args()),
      ...(model().trim()
        ? { model: { id: model().trim(), ...(provider().trim() ? { providerID: provider().trim() } : {}) } }
        : {}),
    }
    if (builtin()) return props.onSave(id().trim(), shared)
    if (!oneShot()) return props.onSave(id().trim(), { ...shared, adapter: adapter() })
    return props.onSave(id().trim(), {
      ...shared,
      resumeArgs: lines(resumeArgs()),
      sessionLine: sessionLine().trim() || undefined,
    })
  }
  return (
    <>
      <div class="section-title">
        {props.product
          ? t("settings.collaboration.edit", { name: props.product.title })
          : t("settings.collaboration.add")}
      </div>
      <form
        class="card form"
        onSubmit={(event) => {
          event.preventDefault()
          if (!problem()) save()
        }}
      >
        <Show when={!props.product}>
          <label class="field">
            {t("settings.collaboration.id")}
            <input class="input mono" value={id()} onInput={(event) => setId(event.currentTarget.value)} />
          </label>
        </Show>
        <label class="field">
          {t("settings.collaboration.title")}
          <input class="input" value={title()} onInput={(event) => setTitle(event.currentTarget.value)} />
        </label>
        <label class="field">
          {t("settings.collaboration.command")}
          <input class="input mono" value={command()} onInput={(event) => setCommand(event.currentTarget.value)} />
        </label>
        <Show when={!builtin()}>
          <div class="field">
            {t("settings.collaboration.adapter")}
            <Select
              class="chip outlined"
              label={t("settings.collaboration.adapter")}
              options={adapters()}
              value={adapter()}
              onChange={(value) => {
                setAdapter(value)
                if (value !== "opencode") setProvider("")
              }}
            />
          </div>
        </Show>
        <label class="field">
          {t("settings.agentConnections.model")}
          <input
            class="input mono"
            value={model()}
            placeholder={t("settings.agentConnections.defaultModel")}
            onInput={(event) => setModel(event.currentTarget.value)}
          />
        </label>
        <Show when={props.product && props.onModels}>
          <div class="row">
            <button class="button ghost sm" type="button" disabled={modelsLoading()} onClick={() => void discover()}>
              {modelsLoading() ? t("settings.collaboration.checking") : t("settings.agentConnections.discoverModels")}
            </button>
            <Show when={models()?.models.length}>
              <Select
                label={t("settings.agentConnections.modelList")}
                value={undefined}
                options={models()!.models.map((item, index) => ({
                  value: String(index),
                  label: item.title,
                  description: item.providerID,
                }))}
                onChange={(index) => {
                  const selected = models()?.models[Number(index)]
                  if (!selected) return
                  setModel(selected.id)
                  setProvider(selected.providerID ?? "")
                }}
              />
            </Show>
          </div>
          <Show when={modelsError()}>
            {(error) => (
              <p class="form-problem" role="status">
                {error()}
              </p>
            )}
          </Show>
        </Show>
        <Show when={adapter() === "opencode"}>
          <label class="field">
            {t("settings.agentConnections.provider")}
            <input class="input mono" value={provider()} onInput={(event) => setProvider(event.currentTarget.value)} />
          </label>
        </Show>
        <label class="field">
          {builtin() || (adapter() !== "member" && adapter() !== "command")
            ? t("settings.collaboration.extraArgs")
            : t("settings.collaboration.args")}
          <textarea
            class="input mono"
            rows={3}
            placeholder={oneShot() ? t("settings.collaboration.argsHint") : undefined}
            value={args()}
            onInput={(event) => setArgs(event.currentTarget.value)}
          />
        </label>
        <Show when={oneShot()}>
          <label class="field">
            {t("settings.collaboration.resumeArgs")}
            <textarea
              class="input mono"
              rows={3}
              placeholder={t("settings.collaboration.resumeArgsHint")}
              value={resumeArgs()}
              onInput={(event) => setResumeArgs(event.currentTarget.value)}
            />
          </label>
          <label class="field">
            {t("settings.collaboration.sessionLine")}
            <input
              class="input mono"
              placeholder={t("settings.collaboration.sessionLineHint")}
              value={sessionLine()}
              onInput={(event) => setSessionLine(event.currentTarget.value)}
            />
          </label>
        </Show>
        <Show when={(id() || command()) && problem()}>
          <p class="form-problem" role="status">
            {problem()}
          </p>
        </Show>
        <div class="row end">
          <button type="button" class="button ghost" onClick={() => props.onCancel()}>
            {t("common.cancel")}
          </button>
          <button type="submit" class="button primary" disabled={!!problem()}>
            {t("common.save")}
          </button>
        </div>
      </form>
    </>
  )
}

/** The products a group can use, each with its state and where it is defined */
export function ProductSettings(props: {
  products: readonly Product[]
  onChange: (change: ProductChange) => Promise<boolean>
  onRefresh: () => Promise<void>
  onVerify?: (product: Product) => Promise<AgentConnectionVerification>
  onModels?: (productID: string) => Promise<AgentConnectionModels>
  /** Opens a conversation in which MerakCode writes an adapter for a CLI it has none for */
  onGenerate?: () => void
}) {
  /** The product in the form, or "new" while one is added */
  const [form, setForm] = createSignal<Product | "new">()
  const [checking, setChecking] = createSignal(false)
  const [verifying, setVerifying] = createSignal<string>()
  const [verification, setVerification] = createSignal<{
    productID: string
    result?: AgentConnectionVerification
    error?: string
  }>()
  let verificationGeneration = 0
  const invalidateVerification = () => {
    verificationGeneration++
    setVerification(undefined)
  }
  createEffect(on(() => props.products, invalidateVerification))
  onCleanup(invalidateVerification)
  const change = (input: ProductChange) => {
    invalidateVerification()
    return props.onChange(input)
  }
  const openForm = (product: Product | "new") => {
    invalidateVerification()
    setForm(product)
  }
  const verify = async (product: Product) => {
    if (!props.onVerify || verifying()) return
    const { id, revision } = product
    setVerifying(id)
    invalidateVerification()
    const request = verificationGeneration
    const current = () =>
      request === verificationGeneration && props.products.find((item) => item.id === id)?.revision === revision
    try {
      const result = await props.onVerify(product)
      if (!current() || result.revision !== revision) return
      setVerification({ productID: id, result })
    } catch (error) {
      if (current())
        setVerification({
          productID: id,
          error: [summary(error), error instanceof Error ? error.message : String(error)].filter(Boolean).join(" · "),
        })
    } finally {
      setVerifying(undefined)
    }
  }
  const verificationText = (product: Product) => {
    const value = verification()
    if (value?.productID !== product.id) return undefined
    if (value.error) return value.error
    const result = value.result
    if (!result) return undefined
    return [
      result.status === "failed" ? summary(result.error) : undefined,
      result.status === "passed"
        ? t("settings.agentConnections.verified")
        : (result.error?.message ?? t("settings.agentConnections.verifyFailed")),
      result.actualModel?.id,
      result.streamingObserved
        ? t("settings.agentConnections.streamingObserved")
        : t("settings.agentConnections.streamingNotObserved"),
    ]
      .filter(Boolean)
      .join(" · ")
  }
  const refresh = () => {
    invalidateVerification()
    setChecking(true)
    void props.onRefresh().finally(() => setChecking(false))
  }
  return (
    <>
      <div class="section-title">
        {t("settings.collaboration.products")}
        <span class="spacer" />
        <button class="button ghost sm" disabled={checking()} onClick={refresh}>
          {checking() ? t("settings.collaboration.checking") : t("settings.collaboration.refresh")}
        </button>
      </div>
      <div class="card">
        <For each={props.products}>
          {(product) => (
            <Row label={product.title} desc={[status(product), verificationText(product)].filter(Boolean).join(" · ")}>
              <For each={badges(product)}>{(label) => <span class="badge neutral">{label}</span>}</For>
              <Show when={product.id !== "merak"}>
                <Show when={props.onVerify}>
                  <button
                    class="button ghost sm"
                    aria-label={t("settings.agentConnections.verify", { name: product.title })}
                    disabled={!!verifying() || !!form() || !product.enabled || !product.connected}
                    onClick={() => void verify(product)}
                  >
                    {verifying() === product.id
                      ? t("settings.collaboration.checking")
                      : t("settings.agentConnections.verifySaved")}
                  </button>
                </Show>
                <Switch
                  label={t("settings.collaboration.enable", { name: product.title })}
                  hideLabel
                  checked={product.enabled}
                  onChange={(enabled) => void change({ type: "enabled", id: product.id, enabled })}
                />
              </Show>
              <Show when={product.id !== "merak"}>
                <button
                  class="icon-button"
                  aria-label={t("settings.collaboration.edit", { name: product.title })}
                  onClick={() => openForm(product)}
                >
                  <Pencil class="icon icon-sm" />
                </button>
              </Show>
              {/* Restoring fields must preserve an explicitly disabled built-in product. */}
              <Show when={product.source === "global"}>
                <button
                  class="icon-button"
                  aria-label={
                    product.builtin
                      ? t("settings.collaboration.restore", { name: product.title })
                      : t("settings.removeItem", { name: product.title })
                  }
                  onClick={() =>
                    void change(
                      product.builtin
                        ? { type: "update", id: product.id, product: {} }
                        : { type: "remove", id: product.id },
                    )
                  }
                >
                  <Show when={product.builtin} fallback={<Trash2 class="icon icon-sm" />}>
                    <RotateCcw class="icon icon-sm" />
                  </Show>
                </button>
              </Show>
            </Row>
          )}
        </For>
      </div>
      <Show
        when={form()}
        keyed
        fallback={
          <div class="row">
            <button class="button secondary" onClick={() => openForm("new")}>
              <Plus class="icon icon-sm" />
              {t("settings.collaboration.add")}
            </button>
            <Show when={props.onGenerate}>
              {(generate) => (
                <button class="button ghost" onClick={() => generate()()}>
                  <Sparkles class="icon icon-sm" />
                  {t("settings.collaboration.generate")}
                </button>
              )}
            </Show>
          </div>
        }
      >
        {(current) => (
          <ProductForm
            product={current === "new" ? undefined : current}
            taken={props.products.map((product) => product.id)}
            onModels={props.onModels}
            onSave={(id, product) =>
              void change({ type: current === "new" ? "add" : "update", id, product }).then(
                (ok) => ok && setForm(undefined),
              )
            }
            onCancel={() => setForm(undefined)}
          />
        )}
      </Show>
    </>
  )
}

/** Global connections shared by direct and group conversations. */
export function AgentConnections() {
  // A project is only needed when opening the optional adapter-writing conversation.
  const directory = () => state.folders[0]?.directory
  const api = () => client()
  const navigate = useNavigate()
  /** A new ordinary conversation in this project, its input filled in for the user to name the CLI */
  const generate = () => {
    const dir = directory()
    if (!dir) return
    fill(choiceKey(undefined, dir), t("settings.collaboration.generatePrompt"))
    setUi("settings", undefined)
    navigate(sessionPath(dir))
  }
  onMount(() => void loadConnections().catch(failed))
  const failed = (error: Error) => {
    toast({ kind: "error", title: t("error.request", { message: error.message }), error })
    return false
  }
  return (
    <Section title={t("settings.agentConnections")} lead={t("settings.agentConnections.desc")}>
      <ProductSettings
        products={agentConnections()}
        onModels={(productID) => call(api().agentConnection.models({ productID }))}
        onVerify={(product) =>
          call(api().agentConnection.verify({ productID: product.id, expectedRevision: product.revision }))
        }
        onChange={(body) => changeConnection(body).then(() => true, failed)}
        onRefresh={() =>
          refreshConnections(true).then(
            () => undefined,
            (error: Error) => void failed(error),
          )
        }
        onGenerate={directory() ? generate : undefined}
      />
    </Section>
  )
}
