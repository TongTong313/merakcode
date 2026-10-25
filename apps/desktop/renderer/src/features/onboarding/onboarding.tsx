import CircleCheck from "lucide-solid/icons/circle-check"
import { createSignal, For, Show } from "solid-js"
import { locale, t } from "../../i18n"
import { call, client } from "../../state/client"
import { connected, loadProviders, state } from "../../state/store"
import { setUi, ui } from "../../state/ui"
import { Dialog } from "../../ui/dialog"
import { providerLabel } from "../../ui/provider-label"

/** Providers listed directly on the onboarding page; the rest are in settings */
const FEATURED = ["alibaba-cn", "deepseek", "zhipuai", "moonshotai-cn", "openai", "anthropic", "google", "openrouter"]

/**
 * Shown while no model is usable: pick a provider, enter a key, verify. Can be skipped, which keeps it closed for the
 * rest of this launch.
 */
export function Onboarding() {
  const [picked, setPicked] = createSignal<string>()
  const [key, setKey] = createSignal("")
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const open = () => !!state.providers && !connected() && !ui.skipped && !ui.settings
  const providers = () =>
    FEATURED.flatMap((id) => {
      const provider = state.providers?.all.find((item) => item.id === id)
      return provider ? [provider] : []
    })
  const directory = () => state.folders[0]?.directory
  const label = (item: { id: string; name: string; origin?: "official" | "configured" }) =>
    providerLabel(item, locale())

  const verify = async () => {
    const providerID = picked()
    if (!providerID || !key().trim()) return
    setBusy(true)
    setError(undefined)
    try {
      await call(client(directory()).auth.set({ providerID, auth: { type: "api", key: key().trim() } }))
      const result = (await call(client(directory()).provider.verify({ providerID }))) as {
        ok?: boolean
        message?: string
      }
      if (result.ok === false) {
        setError(t("settings.provider.invalid", { message: result.message ?? "" }))
        return
      }
      await loadProviders(directory())
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
          <button class="button primary" disabled={!picked() || !key().trim() || busy()} onClick={() => void verify()}>
            {t("settings.provider.verify")}
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
              onKeyDown={(event) => event.key === "Enter" && void verify()}
              autofocus
            />
            <Show when={error()}>
              <div class="error">{error()}</div>
            </Show>
            <Show when={connected()}>
              <div class="verified">
                <CircleCheck class="icon icon-sm" />
                {t("settings.provider.verified")}
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}
