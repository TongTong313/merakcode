import Trash2 from "lucide-solid/icons/trash"
import { createSignal, For, Show } from "solid-js"
import { locale, t } from "../../i18n"
import { client } from "../../state/client"
import { available, shownDefaultModel } from "../../state/models"
import { loadProviders, state, updateConfig } from "../../state/store"
import { Dialog } from "../../ui/dialog"
import { providerLabel } from "../../ui/provider-label"
import { Select } from "../../ui/select"
import { Switch } from "../../ui/switch"
import { toast } from "../../ui/toast"
import { Row, Section } from "./layout"
import { nextPicker } from "./model-visibility"
import { CustomDialog } from "./relay-dialog"

const official = new Set(["openai", "anthropic", "deepseek", "moonshot", "zhipu", "dashscope", "gemini", "openrouter"])
const fail = (error: Error) => toast({ kind: "error", title: t("error.request", { message: error.message }), error })
const label = (id: string) =>
  providerLabel(
    { id, name: state.config?.providers[id]?.name || id, origin: official.has(id) ? "official" : "configured" },
    locale(),
  )

export function Models() {
  const [adding, setAdding] = createSignal(false)
  const [station, setStation] = createSignal<{ id: string; name: string; baseURL: string }>()
  const [editing, setEditing] = createSignal<string>()
  const [modelsFor, setModelsFor] = createSignal<string>()
  const [key, setKey] = createSignal("")
  const [query, setQuery] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const configured = (id: string) => {
    const provider = state.config?.providers[id]
    return provider && !provider.disabled && (provider.hasKey || !!provider.baseURL)
  }
  const providers = () =>
    Object.entries(state.config?.providers ?? {})
      .filter(([id, provider]) => `${id} ${provider.name ?? ""}`.toLowerCase().includes(query().toLowerCase()))
      .toSorted(([a], [b]) => Number(!!configured(b)) - Number(!!configured(a)))
  const save = async (id: string) => {
    setSaving(true)
    try {
      await updateConfig({
        providers: { [id]: { ...state.config?.providers[id], apiKey: key().trim(), disabled: false } },
      })
      setEditing(undefined)
      setKey("")
    } finally {
      setSaving(false)
    }
  }
  const toggle = async (id: string) => {
    await updateConfig({ providers: { [id]: { ...state.config?.providers[id], disabled: !!configured(id) } } })
  }
  return (
    <Section title={t("settings.models")} lead={t("settings.providers.desc")}>
      <div class="card">
        <Row label={t("settings.defaultModel")} desc={t("settings.defaultModel.desc")}>
          <Select
            class="select-field"
            label={t("settings.defaultModel")}
            options={available().map((item) => ({
              value: item.key,
              label: item.model.name,
              description: providerLabel(item.provider, locale()),
              providerID: item.provider.id,
            }))}
            value={shownDefaultModel()}
            placeholder={t("model.none")}
            onChange={(model) => void updateConfig({ model }).catch(fail)}
          />
        </Row>
      </div>
      <div class="section-title">
        {t("settings.providers")}
        <input
          class="input search"
          placeholder={t("settings.provider.search")}
          aria-label={t("settings.provider.search")}
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <button
          class="button secondary sm"
          onClick={() => {
            setStation(undefined)
            setAdding(true)
          }}
        >
          {t("settings.custom.add")}
        </button>
      </div>
      <div class="card">
        <For each={providers()}>
          {([id, provider]) => (
            <div class="setting-row provider-row">
              <span class={configured(id) ? "dot success" : "dot"} />
              <div class="grow">
                <div class="label">{label(id)}</div>
                <div class="desc">
                  {state.models.filter((model) => model.provider === id).length} · {id}
                </div>
                <Show when={editing() === id}>
                  <div class="row key-row">
                    <input
                      class="input"
                      type="password"
                      aria-label={t("settings.provider.key")}
                      placeholder={t("settings.provider.key")}
                      value={key()}
                      onInput={(event) => setKey(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && key().trim() && !saving()) void save(id).catch(fail)
                      }}
                      autofocus
                    />
                    <button
                      class="button primary"
                      disabled={saving() || !key().trim()}
                      onClick={() => void save(id).catch(fail)}
                    >
                      {t("common.save")}
                    </button>
                  </div>
                </Show>
              </div>
              <button class="button ghost sm" onClick={() => setModelsFor(id)}>
                {t("settings.provider.models")}
              </button>
              <button
                class="button secondary sm"
                onClick={() => {
                  setKey("")
                  setEditing(editing() === id ? undefined : id)
                }}
              >
                {t("settings.provider.key")}
              </button>
              <Show
                when={configured(id)}
                fallback={
                  <Show when={provider.disabled && (provider.hasKey || provider.baseURL)}>
                    <button class="button ghost sm" onClick={() => void toggle(id).catch(fail)}>
                      {t("settings.provider.connect")}
                    </button>
                  </Show>
                }
              >
                <span class="badge success">{t("settings.provider.configured")}</span>
                <button class="button ghost sm" onClick={() => void toggle(id).catch(fail)}>
                  {t("settings.provider.disconnect")}
                </button>
              </Show>
              <Show when={provider.station}>
                <button
                  class="button ghost sm"
                  onClick={() => {
                    setStation({
                      id: provider.station!,
                      name: (provider.name || id).split(" · ")[0]!,
                      baseURL: provider.baseURL || "",
                    })
                    setAdding(true)
                  }}
                >
                  {t("settings.relay.group")}
                </button>
              </Show>
              <Show when={!official.has(id)}>
                <button
                  class="icon-button"
                  aria-label={t("settings.removeItem", { name: label(id) })}
                  onClick={() => void updateConfig({ providers: { [id]: null } }).catch(fail)}
                >
                  <Trash2 class="icon icon-sm" />
                </button>
              </Show>
            </div>
          )}
        </For>
      </div>
      <ModelDialog providerID={modelsFor()} onClose={() => setModelsFor(undefined)} />
      <Show when={adding()}>
        <CustomDialog
          open
          station={station()}
          onClose={() => {
            setAdding(false)
            setStation(undefined)
          }}
        />
      </Show>
    </Section>
  )
}

function ModelDialog(props: { providerID?: string; onClose: () => void }) {
  const [refreshing, setRefreshing] = createSignal(false)
  const models = () => state.models.filter((model) => model.provider === props.providerID)
  const save = async (modelID: string, on: boolean) => {
    const id = props.providerID
    if (!id) return
    const provider = state.config?.providers[id]
    await updateConfig({
      providers: { [id]: { ...provider, picker: nextPicker(provider?.picker ?? undefined, modelID, on) } },
    })
  }
  const restore = async () => {
    const id = props.providerID
    if (id)
      await updateConfig({
        providers: { [id]: { ...state.config?.providers[id], picker: { include: [], exclude: [] } } },
      })
  }
  const refresh = async () => {
    setRefreshing(true)
    try {
      await (await client()).model.refresh({ provider: props.providerID })
      await loadProviders()
    } finally {
      setRefreshing(false)
    }
  }
  return (
    <Dialog
      open={!!props.providerID}
      onOpenChange={(open) => !open && props.onClose()}
      class="model-dialog"
      title={props.providerID ? label(props.providerID) : t("settings.provider.models")}
      footer={
        <>
          <button class="button secondary" disabled={refreshing()} onClick={() => void refresh().catch(fail)}>
            {t("settings.relay.fetch")}
          </button>
          <button class="button secondary" onClick={() => void restore().catch(fail)}>
            {t("settings.provider.models.restore")}
          </button>
        </>
      }
    >
      <div class="dialog-body">
        <For each={models()}>
          {(model) => (
            <div class="setting-row">
              <div class="grow">
                <div class="label">{state.config?.providers[model.provider]?.models?.[model.id]?.name || model.id}</div>
                <div class="desc">{model.id}</div>
              </div>
              <Switch
                label={model.id}
                hideLabel
                checked={!state.config?.providers[model.provider]?.picker?.exclude?.includes(model.id)}
                onChange={(on) => void save(model.id, on).catch(fail)}
              />
            </div>
          )}
        </For>
      </div>
    </Dialog>
  )
}
