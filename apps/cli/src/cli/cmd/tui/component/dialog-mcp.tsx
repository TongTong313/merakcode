import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { useLocal } from "../context/local"
import { useSync } from "../context/sync"
import { map, pipe, entries, sortBy } from "remeda"
import { DialogSelect, type DialogSelectRef, type DialogSelectOption } from "../ui/dialog-select"
import { useTheme } from "../context/theme"
import { Keybind } from "@merakcode/util/keybind"
import { TextAttributes } from "@opentui/core"
import { useSDK } from "../context/sdk"
import { useLocale } from "../context/locale"
import { useToast } from "../ui/toast"
import { useDialog, useDialogKeyboard } from "../ui/dialog"
import { Log } from "@merakcode/log/logger"
import { failure } from "@merakcode/log"
import {
  managementMcpRows,
  mcpDialogDefaultTab,
  mcpDialogHasHub,
  mcpDialogSource,
  mcpDialogTabs,
  type McpDialogTab,
  type ManagementMcpSnapshot,
} from "./dialog-mcp-core"

type ManagementResult =
  | { ok: true; snapshot: ManagementMcpSnapshot }
  | {
      ok: false
      error: {
        message: string
        facts: Array<{ action: string; ok: boolean; message?: string }>
      }
      snapshot?: ManagementMcpSnapshot
    }

const log = Log.create({ source: "product", service: "tui.mcp" })

function managementError(result: Extract<ManagementResult, { ok: false }>) {
  return [result.error.message, ...result.error.facts.filter((fact) => !fact.ok).flatMap((fact) => fact.message ?? [])]
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(" · ")
}

function Status(props: { enabled: boolean; loading: boolean }) {
  const { theme } = useTheme()
  const locale = useLocale()
  if (props.loading) {
    return <span style={{ fg: theme.textMuted }}>⋯ {locale.t("mcp.loading")}</span>
  }
  if (props.enabled) {
    return <span style={{ fg: theme.success, attributes: TextAttributes.BOLD }}>✓ {locale.t("mcp.enabled")}</span>
  }
  return <span style={{ fg: theme.textMuted }}>○ {locale.t("mcp.disabled")}</span>
}

function InstalledMcp() {
  const local = useLocal()
  const sync = useSync()
  const sdk = useSDK()
  const locale = useLocale()
  const toast = useToast()
  const { theme } = useTheme()
  const [, setRef] = createSignal<DialogSelectRef<unknown>>()
  const [loading, setLoading] = createSignal<string | null>(null)
  const [removeConfirm, setRemoveConfirm] = createSignal<string>()
  const [managed, setManaged] = createSignal<ManagementMcpSnapshot>()

  const applySnapshot = (snapshot: ManagementMcpSnapshot) => {
    setManaged(snapshot)
    sync.set("mcp", Object.fromEntries(snapshot.servers.map((server) => [server.name, server.status])))
  }

  const loadManaged = async () => {
    const response = await sdk.client.mcpManagement.read(undefined, { throwOnError: true })
    if (!response.data) throw new Error(locale.t("mcp.management.empty"))
    applySnapshot(response.data as ManagementMcpSnapshot)
  }

  onMount(() => {
    if (mcpDialogSource === "runtime") return
    void loadManaged().catch((error) => {
      toast.show({ variant: "error", message: error instanceof Error ? error.message : String(error) })
    })
  })

  const options = createMemo(() => {
    const loadingMcp = loading()
    const removingMcp = removeConfirm()
    const label = (scope: "project" | "global" | undefined) =>
      scope ? `[${locale.t(`skills.location.${scope}`)}]` : ""

    return pipe(
      sync.data.mcp ?? {},
      entries(),
      sortBy(([name]) => name),
      map(([name, status]) => ({
        value: name,
        title:
          removingMcp === name
            ? locale.t("mcp.removeConfirm", { name, key: "ctrl+d" })
            : `${label(status.scope)} ${name}`.trim(),
        description:
          (
            {
              connected: locale.t("mcp.connected"),
              failed: locale.t("mcp.failed"),
              disabled: locale.t("mcp.disabled2"),
              needs_auth: locale.t("mcp.needsAuth"),
            } as Record<string, string>
          )[status.status] ?? status.status,
        footer: <Status enabled={local.mcp.isEnabled(name)} loading={loadingMcp === name} />,
        category: undefined,
        bg: removingMcp === name ? theme.error : undefined,
      })),
    )
  })

  const keybinds = createMemo(() => [
    {
      keybind: Keybind.parse("space")[0],
      title: locale.t("mcp.toggle"),
      onTrigger: async (option: DialogSelectOption<string>) => {
        // Prevent toggling while an operation is already in progress
        if (loading() !== null) return

        setRemoveConfirm(undefined)
        setLoading(option.value)
        try {
          if (mcpDialogSource === "runtime") {
            const before = sync.data.mcp[option.value]?.status
            await local.mcp.toggle(option.value)
            const status = await sdk.client.mcp.status(undefined, { throwOnError: true })
            log.info("MCP toggle status refreshed", {
              name: option.value,
              before,
              after: status.data?.[option.value]?.status,
            })
            if (status.data) {
              sync.set("mcp", status.data)
            } else {
              throw new Error("MCP status missing")
            }
            return
          }

          const server = managementMcpRows(managed()).find((item) => item.name === option.value)
          if (!server) throw new Error(locale.t("mcp.management.missing"))
          const response = await sdk.client.mcpManagement.change(
            { body: { type: "set_enabled", name: server.name, enabled: server.nextEnabled } },
            { throwOnError: true },
          )
          const result = response.data as ManagementResult | undefined
          if (!result) throw new Error(locale.t("mcp.management.empty"))
          if (result.snapshot) applySnapshot(result.snapshot)
          if (!result.ok) throw new Error(managementError(result))
        } catch (error) {
          log.warn("MCP toggle failed", { name: option.value, ...failure(error) })
          if (mcpDialogSource === "runtime") {
            const status = await sdk.client.mcp.status().catch(() => undefined)
            if (status?.data) sync.set("mcp", status.data)
          }
          toast.show({ variant: "error", message: errorMessage(error) })
        } finally {
          setLoading(null)
        }
      },
    },
    {
      keybind: Keybind.parse("ctrl+d")[0],
      title: locale.t("mcp.remove"),
      onTrigger: async (option: DialogSelectOption<string>) => {
        if (loading() !== null) return
        if (removeConfirm() !== option.value) {
          setRemoveConfirm(option.value)
          return
        }

        setLoading(option.value)
        try {
          if (mcpDialogSource === "runtime") {
            const scope = sync.data.mcp?.[option.value]?.scope ?? "global"
            await sdk.client.mcp.remove({ name: option.value, scope }, { throwOnError: true })
            const status = await sdk.client.mcp.status()
            if (status.data) sync.set("mcp", status.data)
          } else {
            const server = managementMcpRows(managed()).find((item) => item.name === option.value)
            if (!server) throw new Error(locale.t("mcp.management.missing"))
            // mcpManagement is public in both SDK variants, so no @sdk-variant-boundary exemption is needed.
            const response = await sdk.client.mcpManagement.change(
              { body: { type: "remove", name: server.name } },
              { throwOnError: true },
            )
            const result = response.data as ManagementResult | undefined
            if (!result) throw new Error(locale.t("mcp.management.empty"))
            if (result.snapshot) applySnapshot(result.snapshot)
            if (!result.ok) throw new Error(managementError(result))
          }

          toast.show({ variant: "success", message: locale.t("mcp.removeSuccess", { name: option.value }) })
        } catch (error) {
          toast.show({ variant: "error", message: errorMessage(error) })
        } finally {
          setRemoveConfirm(undefined)
          setLoading(null)
        }
      },
    },
  ])

  return (
    <DialogSelect
      ref={setRef}
      title={locale.t("dialog.mcp")}
      options={options()}
      keybind={keybinds()}
      onMove={(option) => {
        if (removeConfirm() !== option.value) setRemoveConfirm(undefined)
      }}
      onSelect={() => {
        // Don't close on select, only on escape
      }}
    />
  )
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error !== "object" || !error) return String(error)
  const value = error as { error?: unknown; message?: unknown; data?: { error?: unknown; message?: unknown } }
  if (typeof value.data?.error === "string") return value.data.error
  if (typeof value.data?.message === "string") return value.data.message
  if (typeof value.error === "string") return value.error
  if (typeof value.message === "string") return value.message
  return String(error)
}

function ExternalMcp() {
  const dialog = useDialog()
  const locale = useLocale()
  const { theme } = useTheme()
  const [tab, setTab] = createSignal<McpDialogTab>(mcpDialogDefaultTab)
  dialog.setSize("large")

  useDialogKeyboard((event) => {
    if (event.name !== "tab") return
    const index = mcpDialogTabs.indexOf(tab())
    setTab(mcpDialogTabs[(index + 1) % mcpDialogTabs.length])
    event.preventDefault()
  })

  return (
    <box flexDirection="column" gap={1} paddingLeft={2} paddingRight={2}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.primary} attributes={TextAttributes.BOLD}>
          {locale.t("dialog.mcp")}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc {locale.t("common.cancel")}
        </text>
      </box>
      <box flexDirection="row">
        <For each={mcpDialogTabs}>
          {(item) => (
            <box
              backgroundColor={tab() === item ? theme.primary : undefined}
              paddingLeft={3}
              paddingRight={3}
              onMouseUp={() => setTab(item)}
            >
              <text>{locale.t("mcp.tab.installed")}</text>
            </box>
          )}
        </For>
      </box>
      <Show when={tab() === "installed"}>
        <InstalledMcp />
      </Show>
    </box>
  )
}

export function DialogMcp() {
  return mcpDialogHasHub ? <ExternalMcp /> : <InstalledMcp />
}
