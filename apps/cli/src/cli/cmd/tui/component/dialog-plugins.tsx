import { For, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"

export function DialogPlugins() {
  const sync = useSync()
  const { theme } = useTheme()
  const dialog = useDialog()

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Plugins ({sync.data.plugin.length})
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Show when={sync.data.plugin.length} fallback={<text fg={theme.textMuted}>No plugins</text>}>
        <For each={sync.data.plugin}>
          {(plugin) => (
            <box>
              <text
                fg={
                  plugin.status === "active" ? theme.success : plugin.status === "failed" ? theme.error : theme.warning
                }
              >
                • <b>{plugin.id}</b> [{plugin.status}]
              </text>
              <text fg={theme.textMuted} wrapMode="word">
                {plugin.source} · {plugin.tools.length} tools
                {plugin.error ? ` · ${plugin.error}` : ""}
              </text>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}
