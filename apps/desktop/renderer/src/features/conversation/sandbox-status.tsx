import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { t } from "../../i18n"
import { client } from "../../state/client"
import { toast } from "../../ui/toast"
import { noticeText } from "../group/notice"
import { Popover } from "@kobalte/core/popover"
import Shield from "lucide-solid/icons/shield"
import { trackOverlay } from "../../ui/overlay"

export function SandboxStatus(props: {
  directory: string
  sessionID?: string
  mode: string
  busy: boolean
  group?: string
  member?: string
  remote?: boolean
}) {
  const [installing, setInstalling] = createSignal(false)
  const [open, setOpen] = createSignal(false)
  trackOverlay(open)
  const [status, { refetch }] = createResource(
    () => ({
      workdir: props.directory,
      session: props.sessionID,
      mode: props.mode,
      group: props.group,
      member: props.member,
    }),
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
    <Popover open={open()} onOpenChange={setOpen} placement="top-start" gutter={8}>
      <Popover.Trigger class="chip outlined sandbox-status" aria-label={t("sandbox.hint")}>
        <Shield class="icon icon-sm" />
        {label()}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content class="popover sandbox-details">
          <Popover.Title>{t("sandbox.hint")}</Popover.Title>
          <Show when={status.error}>
            <p>{t("sandbox.state.failed")}</p>
          </Show>
          <Show when={!status.error && status()}>
            {(value) => (
              <>
                <Show when={value().reason}>
                  <p>{noticeText(value().reason!)}</p>
                </Show>
                <Show when={value().backend === "windows-account" && !value().available && !value().disabled}>
                  <Show when={!props.remote} fallback={<p>{t("sandbox.remoteSetup")}</p>}>
                    <p>{t("sandbox.setupNotice")}</p>
                    <button
                      class="button secondary sm"
                      disabled={installing()}
                      onClick={async () => {
                        setInstalling(true)
                        try {
                          await (await client()).sandbox.setup()
                          await refetch()
                        } catch (error) {
                          toast({ kind: "error", title: noticeText("MRK-5004"), error })
                        } finally {
                          setInstalling(false)
                        }
                      }}
                    >
                      {t(installing() ? "settings.sandbox.installing" : "sandbox.install")}
                    </button>
                  </Show>
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
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  )
}
