import { TextAttributes } from "@opentui/core"
import { For, Show, createMemo } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useSync } from "../context/sync"
import { useLocale } from "../context/locale"
import { buildStatusSections, type StatusRow, type StatusTone } from "./status-view"

function toneColor(theme: ReturnType<typeof useTheme>["theme"], tone: StatusTone) {
  if (tone === "success") return theme.success
  if (tone === "error") return theme.error
  if (tone === "warning") return theme.warning
  return theme.textMuted
}

function StatusRows(props: { rows: StatusRow[] }) {
  const { theme } = useTheme()
  return (
    <For each={props.rows}>
      {(row) => (
        <box flexDirection="row" gap={1}>
          <text flexShrink={0} style={{ fg: toneColor(theme, row.tone) }}>
            •
          </text>
          <text fg={theme.text} wrapMode="word">
            <b>{row.title}</b>
            <Show when={row.subtitle}>
              <span style={{ fg: theme.textMuted }}> {row.subtitle}</span>
            </Show>
            <Show when={row.detail}>
              <span style={{ fg: theme.textMuted }}> {row.detail}</span>
            </Show>
          </text>
        </box>
      )}
    </For>
  )
}

function StatusSectionView(props: {
  title: string
  section: { empty: boolean; emptyLabel: string; count: number; rows: StatusRow[] }
}) {
  const { theme } = useTheme()
  return (
    <Show
      when={!props.section.empty}
      fallback={
        <text fg={theme.text} wrapMode="word">
          {props.section.emptyLabel}
        </text>
      }
    >
      <box>
        <text fg={theme.text}>
          {props.title} ({props.section.count})
        </text>
        <StatusRows rows={props.section.rows} />
      </box>
    </Show>
  )
}

/** Read-only status panel summarizing MCP, LSP, formatter and plugin state. */
export function DialogStatus() {
  const sync = useSync()
  const { theme } = useTheme()
  const dialog = useDialog()
  const locale = useLocale()

  const sections = createMemo(() =>
    buildStatusSections({
      mcp: sync.data.mcp,
      lsp: sync.data.lsp,
      formatters: sync.data.formatter,
      plugins: sync.data.plugin,
      labels: {
        mcp: {
          connected: locale.t("mcp.connected"),
          failed: locale.t("mcp.failed"),
          disabled: locale.t("mcp.disabled2"),
        },
        mcpEmpty: locale.t("status.mcp.empty"),
        lspEmpty: locale.t("status.lsp.empty"),
        formatterEmpty: locale.t("status.formatter.empty"),
        pluginEmpty: locale.t("status.plugin.empty"),
      },
    }),
  )

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {locale.t("dialog.status")}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <StatusSectionView title={locale.t("status.mcp.title")} section={sections().mcp} />
      <Show when={sections().lsp}>
        {(lsp) => <StatusSectionView title={locale.t("status.lsp.title")} section={lsp()} />}
      </Show>
      <StatusSectionView title={locale.t("status.formatter.title")} section={sections().formatters} />
      <StatusSectionView title={locale.t("status.plugin.title")} section={sections().plugins} />
    </box>
  )
}
