import type { SandboxStatus, PermissionLevel } from "@merakcode/sdk/client"
import Shield from "lucide-solid/icons/shield"
import { createEffect, createResource, createSignal, onCleanup, Show } from "solid-js"
import { t } from "../../i18n"
import { call, client } from "../../state/client"
import { Select, type Option } from "../../ui/select"
import { toast } from "../../ui/toast"
import { Tip } from "../../ui/tooltip"
import { bridge, storage } from "../../lib/bridge"
import { listen } from "../../state/store"

/** Reports actual sandbox readiness and offers repair through the SDK. */
export function SandboxControl(props: {
  status: SandboxStatus | undefined
  busy: boolean
  disabled?: boolean
  onInstall: () => void
  onPrepare?: () => void
}) {
  const word = () => {
    if (props.busy || props.status?.status === "starting") return t("sandbox.state.starting")
    if (!props.status) return t("sandbox.state.checking")
    if (props.status.status === "on") return t("sandbox.state.on")
    if (props.status.status === "failed") return t("sandbox.state.failed")
    if (props.status.status === "unsupported" && !props.status.installable) return t("sandbox.state.unsupported")
    return t("sandbox.state.off")
  }
  const options = (): Option<"install">[] => {
    const status = props.status
    if (!status || props.busy || status.status === "on" || status.status === "starting" || status.status === "off")
      return []
    return [
      {
        value: "install",
        label: t(status.installable ? "sandbox.install" : "sandbox.retry"),
        description: status.reason ?? t("sandbox.installDesc"),
      },
    ]
  }

  return (
    <Tip
      label={
        props.status?.reason
          ? `${props.status.errorCode ? `[${props.status.errorCode}] ` : ""}${props.status.reason}`
          : t("sandbox.hint")
      }
      placement="top"
    >
      <Select
        label={t("sandbox.named", { state: word() })}
        options={options()}
        value={undefined}
        disabled={props.busy || props.status?.status === "starting" || props.disabled || !props.status}
        placeholder={
          <>
            <Shield class="icon icon-sm" />
            <Show when={word()}>
              <span>{word()}</span>
            </Show>
          </>
        }
        onPrepare={props.onPrepare}
        onChange={props.onInstall}
      />
    </Tip>
  )
}

/** Composer control: shows the sandbox state for this project and applies the chosen action. */
export function SandboxField(props: { directory: string; disabled?: boolean; permissionLevel?: PermissionLevel }) {
  const [status, { refetch, mutate }] = createResource(
    () => props.directory,
    (directory) => call(client(directory).sandbox.status()).catch(() => undefined),
  )
  onCleanup(
    listen((_directory, event) => {
      if (event.type === "sandbox.updated") mutate(event.properties)
    }),
  )
  const [busy, setBusy] = createSignal(false)
  const run = async () => {
    if (props.disabled || busy()) return
    setBusy(true)
    try {
      const result = await call(client(props.directory).sandbox.install())
      mutate(result)
      if (result.status === "failed") throw Object.assign(new Error(result.reason), { code: result.errorCode })
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      toast({ kind: "error", title: t("error.request", { message: failure.message }), error: failure })
    } finally {
      setBusy(false)
    }
  }
  createEffect(() => {
    if (bridge?.os !== "windows" || status()?.status !== "unsupported" || !status()?.installable || props.disabled)
      return
    void (async () => {
      const key = "sandbox-setup-attempted-v3"
      if (await storage.get(key, false)) return
      await storage.set(key, true)
      toast({ kind: "info", title: t("sandbox.setupNotice") })
      await run()
    })()
  })
  return (
    <>
      <Show when={props.permissionLevel === "autoApprove" && status()?.status !== "on"}>
        <span class="subtle">{t("permissionLevel.degraded")}</span>
      </Show>
      <SandboxControl
        status={status()}
        busy={busy()}
        disabled={props.disabled}
        onInstall={() => void run()}
        onPrepare={() => void refetch()}
      />
    </>
  )
}
