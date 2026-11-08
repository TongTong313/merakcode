import CircleCheck from "lucide-solid/icons/circle-check"
import { createSignal, For, Show } from "solid-js"
import { locale, t } from "../../i18n"
import { connected, updateConfig, state } from "../../state/store"
import { setUi, ui } from "../../state/ui"
import { Dialog } from "../../ui/dialog"
import { providerLabel } from "../../ui/provider-label"

/** Providers listed directly on the onboarding page; the rest are in settings */
const FEATURED = ["dashscope", "deepseek", "zhipu", "moonshot", "openai", "anthropic", "gemini", "openrouter"]

/**
 * Shown while no model is usable: pick a provider and save a key. Can be skipped, which keeps it closed for the
 * rest of this launch.
 */
export function Onboarding() {
  const [picked, setPicked] = createSignal<string>()
  const [key, setKey] = createSignal("")
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const open = () => !!state.config && !connected() && !ui.skipped && !ui.settings
  const providers = () =>
    FEATURED.flatMap((id) => {
      const provider = state.config?.providers[id]
      return provider ? [{ id, name: provider.name || id, origin: "official" as const }] : []
    })
  const label = (item: { id: string; name: string; origin?: "official" | "configured" }) =>
    providerLabel(item, locale())

  const save = async () => {
    const providerID = picked()
    if (!providerID || !key().trim() || busy()) return
    setBusy(true)
    setError(undefined)
    try {
      await updateConfig({
        providers: { [providerID]: { ...state.config?.providers[providerID], apiKey: key().trim(), disabled: false } },
      })
      setKey("")
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open()}
      onOpenChange={(next) => !next && setUi("skipped", true)}
      title={t("onboarding.title")}
      description={t("onboarding.lead")}
      class="wide onboarding"
      footer={
        <>
          <button class="button ghost" onClick={() => setUi("settings", "models")}>
            {t("onboarding.more")}
          </button>
          <span class="spacer" />
          <button class="button secondary" onClick={() => setUi("skipped", true)}>
            {t("onboarding.skip")}
          </button>
          <button class="button primary" disabled={!picked() || !key().trim() || busy()} onClick={() => void save()}>
            {t("common.save")}
          </button>
        </>
      }
    >
      <div class="dialog-body form">
        <div class="providers">
          <For each={providers()}>
            {(item) => (
              <button class="provider" aria-pressed={picked() === item.id} onClick={() => setPicked(item.id)}>
                <span class="mark">{label(item).slice(0, 1)}</span>
                {label(item)}
              </button>
            )}
          </For>
        </div>
        <Show when={picked()}>
          <div class="field">
            <label for="onboarding-key">{t("settings.provider.key")}</label>
            <input
              id="onboarding-key"
              class="input"
              type="password"
              value={key()}
              onInput={(event) => setKey(event.currentTarget.value)}
              onKeyDown={(event) => event.key === "Enter" && !event.isComposing && void save()}
              autofocus
            />
            <Show when={error()}>
              <div class="error">{error()}</div>
            </Show>
            <Show when={connected()}>
              <div class="verified">
                <CircleCheck class="icon icon-sm" />
                {t("settings.provider.configured")}
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}
