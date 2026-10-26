import type { SandboxStatus } from "@merakcode/sdk/client"
import Shield from "lucide-solid/icons/shield"
import { createResource, createSignal, Show } from "solid-js"
import { t } from "../../i18n"
import { call, client } from "../../state/client"
import { updateConfig } from "../../state/store"
import { Select, type Option } from "../../ui/select"
import { toast } from "../../ui/toast"
import { Tip } from "../../ui/tooltip"

/** Initializes the sandbox, or turns it on or off, without restarting the open conversation. */
export async function changeSandbox(directory: string, action: "install" | "preferred" | "off") {
  if (action === "install") await call(client(directory).sandbox.install())
  await updateConfig({ sandbox: { mode: action === "install" ? "preferred" : action } }, { skipDispose: true })
}

type Action = "install" | "preferred" | "off"

/** Sandbox state in the composer. The button shows the state; the menu offers what can be done now. */
export function SandboxControl(props: {
  status: SandboxStatus | undefined
  busy: boolean
  onInstall: () => void
  onMode: (mode: "preferred" | "off") => void
  onPrepare?: () => void
}) {
  const running = () => props.status?.status === "on" && !props.busy
  const word = () => {
    if (!props.status) return undefined
    if (props.busy || !running()) return t("sandbox.state.off")
    return t("sandbox.state.on")
  }
  const options = (): Option<Action>[] => {
    const status = props.status
    if (!status || props.busy) return []
    const install = { value: "install" as const, label: t("sandbox.install"), description: t("sandbox.installDesc") }
    const open = { value: "preferred" as const, label: t("sandbox.open"), description: t("sandbox.openDesc") }
    const close = {
      value: "off" as const,
      label: t("sandbox.close"),
      description: status.status === "unsupported" && status.reason ? status.reason : t("sandbox.closeDesc"),
    }
    if (status.status === "on") return [close]
    if (status.installable) return [install, close]
    if (status.status === "off") return [open]
    return [close]
  }

  return (
    <Tip label={t("sandbox.hint")} placement="top">
      <Select
        label={word() ? t("sandbox.named", { state: word()! }) : t("sandbox.hint")}
        options={options()}
        value={undefined}
        disabled={props.busy || !props.status}
        placeholder={
          <>
            <Shield class="icon icon-sm" />
            <Show when={word()}>
              <span>{word()}</span>
            </Show>
          </>
        }
        onPrepare={props.onPrepare}
        onChange={(action) => {
          if (action === "install") props.onInstall()
          else props.onMode(action)
        }}
      />
    </Tip>
  )
}

/** Composer control: shows the sandbox state for this project and applies the chosen action. */
export function SandboxField(props: { directory: string }) {
  const [status, { refetch }] = createResource(
    () => props.directory,
    (directory) => call(client(directory).sandbox.status()).catch(() => undefined),
  )
  const [busy, setBusy] = createSignal(false)
  const run = async (action: "install" | "preferred" | "off") => {
    setBusy(true)
    try {
      await changeSandbox(props.directory, action)
      await refetch()
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      toast({ kind: "error", title: t("error.request", { message: failure.message }), error: failure })
    } finally {
      setBusy(false)
    }
  }
  return (
    <SandboxControl
      status={status()}
      busy={busy()}
      onInstall={() => void run("install")}
      onMode={(mode) => void run(mode)}
      onPrepare={() => void refetch()}
    />
  )
}
