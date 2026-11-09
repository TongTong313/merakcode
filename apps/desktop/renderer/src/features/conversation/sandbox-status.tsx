import { createEffect, createResource, For, onCleanup, Show } from "solid-js"
import { t } from "../../i18n"
import { client } from "../../state/client"

export function SandboxStatus(props: { directory: string; sessionID?: string; mode: string; busy: boolean }) {
  const [status, { refetch }] = createResource(
    () => ({ workdir: props.directory, session: props.sessionID, mode: props.mode }),
    async (params) => (await client()).sandbox.status(params),
  )
  createEffect(() => {
    if (!props.busy) return
    const timer = setInterval(() => void refetch(), 3000)
    onCleanup(() => clearInterval(timer))
  })
  const label = () => {
    if (status.error) return t("sandbox.state.failed")
    const value = status()
    if (!value) return t("sandbox.state.checking")
    if (value.disabled) return t("sandbox.state.disabled")
    if (value.waitingAccount) return t("sandbox.state.waiting")
    if (!value.available) return t("settings.sandbox.unavailable")
    if (value.network === "none" || value.limits?.length || value.protect?.some((path) => path.state === "unenforced"))
      return t("sandbox.state.partial")
    return t("sandbox.state.on")
  }
  const limits: Record<string, () => string> = {
    "loopback-open": () => t("sandbox.limit.loopback"),
    "own-addresses-open": () => t("sandbox.limit.ownAddresses"),
    "port-only": () => t("sandbox.limit.ports"),
    "udp-open": () => t("sandbox.limit.udp"),
  }
  return (
    <details class="sandbox-status" aria-label={t("sandbox.hint")}>
      <summary class="chip outlined">{label()}</summary>
      <Show when={status.error}>
        <p>{t("sandbox.state.failed")}</p>
      </Show>
      <Show when={!status.error && status()}>
        {(value) => (
          <>
            <Show when={value().reason}>
              <p>{value().reason}</p>
            </Show>
            <Show when={value().available && value().network === "none"}>
              <p>{t("sandbox.limit.network")}</p>
            </Show>
            <For each={value().limits ?? []}>{(limit) => <p>{limits[limit]?.() ?? limit}</p>}</For>
            <For each={value().protect?.filter((path) => path.state === "unenforced") ?? []}>
              {(path) => <p>{t("sandbox.limit.rollback", { path: path.path })}</p>}
            </For>
          </>
        )}
      </Show>
    </details>
  )
}
