import { createEffect, createSignal, For, Show } from "solid-js"
import type { ConfigProvider } from "@merakcode/sdk"
import { t } from "../../i18n"
import { client } from "../../state/client"
import { state, updateConfig } from "../../state/store"
import { Dialog } from "../../ui/dialog"
import { Segmented } from "../../ui/segmented"
import { toast } from "../../ui/toast"
import { manualRow, modelConfig, rowOf, windowsValid, type Endpoint, type RelayRow } from "./relay-models"

type Kind = "claude-code" | "codex" | "standard" | "custom"

function apiRoot(url: string) {
  const trimmed = url.trim().replace(/\/+$/, "")
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`
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
  const [protocol, setProtocol] = createSignal<Endpoint>("openai")
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

  const draft = (): ConfigProvider => ({
    protocol: kind() === "claude-code" ? "anthropic" : protocol(),
    baseURL: apiRoot(url()),
    apiKey: key().trim(),
    auth: kind() === "custom" ? auth() : "bearer",
    ...(kind() === "custom" ? { headers: headersOf(headers()) } : {}),
  })

  const load = async () => {
    try {
      const found = await (await client()).model.discover({ provider: draft() })
      setRows((found ?? []).map(rowOf))
    } catch (error) {
      setRows([])
      toast({
        kind: "error",
        title: t("error.request", { message: error instanceof Error ? error.message : String(error) }),
      })
    }
    setStep("models")
  }

  const addManual = () => {
    const id = manual().trim()
    if (!id || rows().some((row) => row.id === id)) return
    setRows((list) => [...list, manualRow(id)])
    setManual("")
  }

  const save = async () => {
    const taken = new Set(Object.keys(state.config?.providers ?? {}))
    const station = props.station?.id ?? slug(name(), taken)
    const id = slug(`${station}-${kind()}`, taken)
    const provider: ConfigProvider = {
      ...draft(),
      name: `${name().trim()} · ${t(kinds().find((item) => item[0] === kind())![1])}`,
      station,
      group: kind(),
      models: Object.fromEntries(
        rows()
          .filter((row) => row.selected)
          .map((row) => [row.id, modelConfig(row)]),
      ),
    }
    await updateConfig({ providers: { [id]: provider } })
    props.onClose()
  }

  const saveCompatible = async () => {
    const id = slug(compatibleName(), new Set(Object.keys(state.config?.providers ?? {})))
    await updateConfig({
      providers: {
        [id]: {
          name: compatibleName().trim(),
          protocol: "openai",
          baseURL: compatibleUrl().trim(),
          apiKey: compatibleKey().trim(),
          models: Object.fromEntries(ids().map((model) => [model, { name: model }])),
        },
      },
    })
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
            <Show when={kind() !== "claude-code"}>
              <Segmented
                label={t("settings.relay.protocol")}
                options={[
                  { value: "anthropic", label: t("settings.relay.protocol.anthropic") },
                  { value: "openai", label: t("settings.relay.protocol.chat") },
                ]}
                value={protocol()}
                onChange={setProtocol}
              />
            </Show>
            <Show when={kind() === "custom"}>
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
