import { createResource, createSignal, onCleanup, onMount, Show } from "solid-js"
import { t } from "../../i18n"
import { client } from "../../state/client"
import { loadGroups } from "../../state/groups"
import { state } from "../../state/store"
import { toast } from "../../ui/toast"
import { Row, Section } from "./layout"

export function Cloud() {
  const [status, { refetch, mutate }] = createResource(async () => (await client()).cloud.status())
  const [endpoint, setEndpoint] = createSignal(state.config?.cloud?.endpoint ?? "ws://127.0.0.1:8787")
  const [busy, setBusy] = createSignal(false)
  onMount(() => {
    const timer = setInterval(() => void refetch(), 2000)
    onCleanup(() => clearInterval(timer))
  })
  const change = async (login: boolean) => {
    setBusy(true)
    try {
      const connection = await client()
      if (login) mutate(await connection.cloud.login({ dev: true, endpoint: endpoint().trim() }))
      else {
        await connection.cloud.logout()
        mutate(await connection.cloud.status())
      }
      await loadGroups()
    } catch (error) {
      toast({ kind: "error", title: t("error.request", { message: "MRK-1007" }), error })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section title={t("cloud.title")}>
      <div class="card">
        <Row label={t("cloud.account")} desc={status()?.account ?? t("cloud.signedOut")}>
          <span role="status">{status()?.online ? t("cloud.online") : t("cloud.offline")}</span>
        </Row>
        <Show when={status()?.device}>
          {(device) => (
            <Row label={t("cloud.device")} desc={device()}>
              {null}
            </Row>
          )}
        </Show>
        <Show
          when={status()?.account}
          fallback={
            <div class="form">
              <p class="subtle">{t("cloud.development")}</p>
              <label class="field">
                <span>{t("cloud.endpoint")}</span>
                <input
                  class="input"
                  aria-label={t("cloud.endpoint")}
                  value={endpoint()}
                  disabled={busy()}
                  onInput={(event) => setEndpoint(event.currentTarget.value)}
                />
              </label>
              <button class="button primary" disabled={busy() || !endpoint().trim()} onClick={() => void change(true)}>
                {t("cloud.login")}
              </button>
            </div>
          }
        >
          <button class="button secondary" disabled={busy()} onClick={() => void change(false)}>
            {t("cloud.logout")}
          </button>
        </Show>
        <Show when={status.error}>
          <p role="alert">{t("error.request", { message: "MRK-1007" })}</p>
        </Show>
      </div>
    </Section>
  )
}
