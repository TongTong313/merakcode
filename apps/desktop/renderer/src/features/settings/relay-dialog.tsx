import { createEffect, createSignal, For, Show } from "solid-js"
import type { Config } from "@merakcode/sdk/client"
import { t } from "../../i18n"
import { call, client } from "../../state/client"
import { loadProviders, state, updateConfig } from "../../state/store"
import { Dialog } from "../../ui/dialog"
import { Segmented } from "../../ui/segmented"
import { toast } from "../../ui/toast"
import { manualRow, modelConfig, rowOf, windowsValid, type Endpoint, type RelayRow } from "./relay-models"

type Kind = "claude-code" | "codex" | "standard" | "custom"

const project = () => state.folders[0]?.directory

/** The SDKs append their own path, so the saved address has to end in /v1. */
function apiRoot(url: string) {
  const trimmed = url.trim().replace(/\/+$/, "")
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`
}

function npmOf(endpoint: Endpoint) {
  if (endpoint === "anthropic") return "@ai-sdk/anthropic"
  if (endpoint === "openai-responses") return "@ai-sdk/openai"
  return "@ai-sdk/openai-compatible"
}

function chosenEndpoint(kind: Kind, endpoint: Endpoint, custom: Endpoint) {
  if (kind === "claude-code") return "anthropic"
  if (kind === "codex") return "openai-responses"
  if (kind === "custom") return custom
  return endpoint
}

function headersOf(text: string) {
  const headers: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const index = line.indexOf(":")
    if (index <= 0) continue
    const name = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    if (name && value) headers[name] = value
  }
  return headers
}

function source(from: RelayRow["contextFrom"]) {
  if (from === "relay") return t("settings.relay.source.relay")
  if (from === "catalog") return t("settings.relay.source.catalog")
  return t("settings.relay.source.fallback")
}

function slug(name: string, taken: Set<string>) {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "relay"
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  return id
}

/**
 * Add a custom provider in one fixed dialog. Compatible endpoints and relay groups share the frame, so switching
 * mode or group does not resize or replace it. A station is several groups (each with its own token); opening with
 * a station adds one more group. Model limits come from the engine's discover call.
 */
export function CustomDialog(props: {
  open: boolean
  onClose: () => void
  station?: { id: string; name: string; baseURL: string }
}) {
  const [relay, setRelay] = createSignal(Boolean(props.station))
  const [compatibleName, setCompatibleName] = createSignal("")
  const [compatibleUrl, setCompatibleUrl] = createSignal("")
  const [compatibleKey, setCompatibleKey] = createSignal("")
  const [models, setModels] = createSignal("")
  const [compatibleBusy, setCompatibleBusy] = createSignal(false)
  const [name, setName] = createSignal(props.station?.name ?? "")
  const [url, setUrl] = createSignal(props.station?.baseURL ?? "")
  const [key, setKey] = createSignal("")
  const [kind, setKind] = createSignal<Kind>("standard")
  const [protocol, setProtocol] = createSignal<Endpoint>("anthropic")
  const [auth, setAuth] = createSignal<"bearer" | "x-api-key">("bearer")
  const [headers, setHeaders] = createSignal("")
  let headersBox: HTMLTextAreaElement | undefined
  // The default window is shorter than this step, so the headers field would sit below the dialog body
  createEffect(() => {
    if (kind() !== "custom") return
    requestAnimationFrame(() => headersBox?.scrollIntoView({ block: "nearest" }))
  })
  const [rows, setRows] = createSignal<RelayRow[]>([])
  const [manual, setManual] = createSignal("")
  const [step, setStep] = createSignal<"connect" | "models">("connect")
  const [busy, setBusy] = createSignal(false)
  const ids = () =>
    models()
      .split(/[\s,]+/)
      .filter(Boolean)

  const kinds = () =>
    [
      ["claude-code", "settings.relay.kind.claudeCode", "settings.relay.kind.claudeCode.hint"],
      ["codex", "settings.relay.kind.codex", "settings.relay.kind.codex.hint"],
      ["standard", "settings.relay.kind.standard", "settings.relay.kind.standard.hint"],
      ["custom", "settings.relay.kind.custom", "settings.relay.kind.custom.hint"],
    ] as const

  const ready = () => {
    const selected = rows().filter((row) => row.selected && row.id)
    return selected.length > 0 && selected.every(windowsValid)
  }

  const load = async () => {
    const found = await call(
      client(project()).provider.relay.discover({ baseURL: url().trim(), key: key().trim(), kind: kind() }),
    )
    if ("error" in found) {
      toast({ kind: "error", title: found.error })
      setRows([])
      setStep("models")
      return
    }
    setRows(found.models.map(rowOf))
    setStep("models")
  }

  const addManual = () => {
    const id = manual().trim()
    if (!id || rows().some((row) => row.id === id)) return
    setRows((list) => [...list, manualRow(id)])
    setManual("")
  }

  const save = async () => {
    const taken = new Set([
      ...(state.providers?.all ?? []).map((provider) => provider.id),
      ...Object.keys(state.config?.provider ?? {}),
    ])
    const station = props.station?.id ?? slug(name(), taken)
    const selected = rows().filter((row) => row.selected)
    const endpoints = selected.map((row) => chosenEndpoint(kind(), row.endpoint, protocol()))
    const id = slug(`${station}-${kind()}`, taken)
    const extra = kind() === "custom" ? headersOf(headers()) : {}
    const provider: NonNullable<Config["provider"]>[string] = {
      name: `${name().trim()} · ${t(kinds().find((item) => item[0] === kind())![1])}`,
      npm: npmOf(endpoints[0] ?? "openai-chat"),
      api: apiRoot(url()),
      relay: {
        station,
        group: kind(),
        kind: kind(),
        ...(kind() === "custom" ? { auth: auth() } : {}),
      },
      ...(Object.keys(extra).length ? { options: { headers: extra } } : {}),
      models: Object.fromEntries(
        selected.map((row, index) => [row.id, modelConfig(row, npmOf(endpoints[index] ?? "openai-chat"))]),
      ),
    }
    await call(client(project()).auth.set({ providerID: id, auth: { type: "api", key: key().trim() } }))
    const enabled = state.config?.enabled_providers
    await updateConfig({
      provider: { [id]: provider },
      ...(enabled ? { enabled_providers: [...enabled, id] } : {}),
    })
    await loadProviders(project())
    props.onClose()
  }

  const saveCompatible = async () => {
    const taken = new Set([
      ...(state.providers?.all ?? []).map((provider) => provider.id),
      ...Object.keys(state.config?.provider ?? {}),
    ])
    const base =
      compatibleName()
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "custom"
    let id = base
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
    // Local models rarely need a key, but the engine only lists providers that have one: store a placeholder
    await call(
      client(project()).auth.set({ providerID: id, auth: { type: "api", key: compatibleKey().trim() || "none" } }),
    )
    const enabled = state.config?.enabled_providers
    await updateConfig({
      provider: {
        [id]: {
          name: compatibleName().trim(),
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: compatibleUrl().trim() },
          models: Object.fromEntries(ids().map((model) => [model, { name: model }])),
        },
      },
      ...(enabled ? { enabled_providers: [...enabled, id] } : {}),
    })
    await loadProviders(project())
    setCompatibleName("")
    setCompatibleUrl("")
    setCompatibleKey("")
    setModels("")
    props.onClose()
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => !open && props.onClose()}
      title={t("settings.custom.title")}
      description={relay() ? t("settings.relay.desc") : t("settings.custom.desc")}
      class="stable"
      footer={
        <Show
          when={relay()}
          fallback={
            <>
              <button class="button secondary" onClick={() => props.onClose()}>
                {t("common.cancel")}
              </button>
              <button
                class="button primary"
                disabled={compatibleBusy() || !compatibleName().trim() || !compatibleUrl().trim() || !ids().length}
                onClick={() => {
                  setCompatibleBusy(true)
                  void saveCompatible()
                    .catch((error: Error) =>
                      toast({ kind: "error", title: t("error.request", { message: error.message }), error }),
                    )
                    .finally(() => setCompatibleBusy(false))
                }}
              >
                {t("common.add")}
              </button>
            </>
          }
        >
          <>
            <button
              class="button secondary"
              onClick={() => (step() === "models" ? setStep("connect") : props.onClose())}
            >
              {step() === "models" ? t("settings.relay.back") : t("common.cancel")}
            </button>
            <Show
              when={step() === "models"}
              fallback={
                <button
                  class="button primary"
                  disabled={busy() || !name().trim() || !url().trim() || !key().trim()}
                  onClick={() => {
                    setBusy(true)
                    void load()
                      .catch((error: Error) =>
                        toast({ kind: "error", title: t("error.request", { message: error.message }), error }),
                      )
                      .finally(() => setBusy(false))
                  }}
                >
                  {t("settings.relay.fetch")}
                </button>
              }
            >
              <button
                class="button primary"
                disabled={busy() || !ready()}
                onClick={() => {
                  setBusy(true)
                  void save()
                    .catch((error: Error) =>
                      toast({ kind: "error", title: t("error.request", { message: error.message }), error }),
                    )
                    .finally(() => setBusy(false))
                }}
              >
                {t("common.add")}
              </button>
            </Show>
          </>
        </Show>
      }
    >
      <div class="dialog-body form">
        <Show when={!props.station}>
          <Segmented
            label={t("settings.custom.add")}
            options={[
              { value: "compatible", label: t("settings.relay.mode.compatible") },
              { value: "relay", label: t("settings.relay.mode.relay") },
            ]}
            value={relay() ? "relay" : "compatible"}
            onChange={(value) => setRelay(value === "relay")}
          />
        </Show>
        <Show
          when={relay()}
          fallback={
            <>
              <label class="field">
                {t("settings.custom.name")}
                <input
                  class="input"
                  value={compatibleName()}
                  onInput={(event) => setCompatibleName(event.currentTarget.value)}
                  autofocus
                />
              </label>
              <label class="field">
                {t("settings.custom.url")}
                <input
                  class="input mono"
                  placeholder="http://localhost:11434/v1"
                  value={compatibleUrl()}
                  onInput={(event) => setCompatibleUrl(event.currentTarget.value)}
                />
              </label>
              <label class="field">
                {t("settings.provider.key")}
                <input
                  class="input"
                  type="password"
                  placeholder={t("settings.custom.keyPlaceholder")}
                  value={compatibleKey()}
                  onInput={(event) => setCompatibleKey(event.currentTarget.value)}
                />
              </label>
              <label class="field">
                {t("settings.custom.models")}
                <textarea
                  class="input mono"
                  rows={2}
                  placeholder={t("settings.custom.modelsPlaceholder")}
                  value={models()}
                  onInput={(event) => setModels(event.currentTarget.value)}
                />
              </label>
            </>
          }
        >
          <Show
            when={step() === "connect"}
            fallback={
              <>
                <Show when={!rows().length}>
                  <p class="desc">{t("settings.relay.empty")}</p>
                </Show>
                <div class="relay-models">
                  <div class="relay-model relay-head">
                    <span />
                    <span />
                    <span>{t("settings.relay.context")}</span>
                    <span>{t("settings.relay.output")}</span>
                  </div>
                  <For each={rows()}>
                    {(row, index) => (
                      <div class="relay-model">
                        <input
                          type="checkbox"
                          checked={row.selected}
                          aria-label={row.id}
                          onChange={(event) =>
                            setRows((list) =>
                              list.map((item, itemIndex) =>
                                itemIndex === index() ? { ...item, selected: event.currentTarget.checked } : item,
                              ),
                            )
                          }
                        />
                        <span>
                          <span class="label">{row.id}</span>
                          <span class="desc">
                            {source(row.contextFrom)}
                            {row.outputFrom && row.outputFrom !== row.contextFrom ? ` · ${source(row.outputFrom)}` : ""}
                          </span>
                        </span>
                        <input
                          class="input mono"
                          inputMode="numeric"
                          aria-label={t("settings.relay.context")}
                          value={row.context}
                          onInput={(event) =>
                            setRows((list) =>
                              list.map((item, itemIndex) =>
                                itemIndex === index() ? { ...item, context: event.currentTarget.value } : item,
                              ),
                            )
                          }
                        />
                        <input
                          class="input mono"
                          inputMode="numeric"
                          aria-label={t("settings.relay.output")}
                          value={row.output}
                          onInput={(event) =>
                            setRows((list) =>
                              list.map((item, itemIndex) =>
                                itemIndex === index() ? { ...item, output: event.currentTarget.value } : item,
                              ),
                            )
                          }
                        />
                      </div>
                    )}
                  </For>
                </div>
                <label class="field">
                  {t("settings.relay.manual")}
                  <span class="row">
                    <input
                      class="input mono"
                      value={manual()}
                      onInput={(event) => setManual(event.currentTarget.value)}
                      onKeyDown={(event) => event.key === "Enter" && addManual()}
                    />
                    <button class="button secondary" type="button" disabled={!manual().trim()} onClick={addManual}>
                      {t("settings.relay.addModel")}
                    </button>
                  </span>
                </label>
              </>
            }
          >
            <label class="field">
              {t("settings.custom.name")}
              <input class="input" value={name()} onInput={(event) => setName(event.currentTarget.value)} />
            </label>
            <label class="field">
              {t("settings.custom.url")}
              <input
                class="input mono"
                placeholder="https://example.com"
                value={url()}
                onInput={(event) => setUrl(event.currentTarget.value)}
              />
            </label>
            <label class="field">
              {t("settings.provider.key")}
              <input
                class="input"
                type="password"
                value={key()}
                onInput={(event) => setKey(event.currentTarget.value)}
              />
            </label>
            <div class="field" role="radiogroup" aria-label={t("settings.relay.kind")}>
              <span class="label">{t("settings.relay.kind")}</span>
              <For each={kinds()}>
                {(item) => (
                  <label class="relay-kind">
                    <input
                      type="radio"
                      name="relay-kind"
                      checked={kind() === item[0]}
                      onChange={() => setKind(item[0])}
                    />
                    <span>
                      <span class="label">{t(item[1])}</span>
                      <span class="desc">{t(item[2])}</span>
                    </span>
                  </label>
                )}
              </For>
              <Show when={kind() === "claude-code" || kind() === "codex"}>
                <p class="desc">{t("settings.relay.kind.note")}</p>
              </Show>
            </div>
            <Show when={kind() === "custom"}>
              <Segmented
                label={t("settings.relay.protocol")}
                options={[
                  { value: "anthropic", label: t("settings.relay.protocol.anthropic") },
                  { value: "openai-responses", label: t("settings.relay.protocol.responses") },
                  { value: "openai-chat", label: t("settings.relay.protocol.chat") },
                ]}
                value={protocol()}
                onChange={setProtocol}
              />
              <Segmented
                label={t("settings.relay.auth")}
                options={[
                  { value: "bearer", label: t("settings.relay.auth.bearer") },
                  { value: "x-api-key", label: t("settings.relay.auth.apiKey") },
                ]}
                value={auth()}
                onChange={setAuth}
              />
              <label class="field">
                {t("settings.relay.headers")}
                <textarea
                  ref={headersBox}
                  class="input mono"
                  rows={2}
                  placeholder={t("settings.relay.headersPlaceholder")}
                  value={headers()}
                  onInput={(event) => setHeaders(event.currentTarget.value)}
                />
              </label>
            </Show>
          </Show>
        </Show>
      </div>
    </Dialog>
  )
}
