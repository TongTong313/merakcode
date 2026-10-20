import { useLocale } from "../context/locale"
import { TextAttributes } from "@opentui/core"
import { createMemo, For } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog, useDialogKeyboard } from "./dialog"
import { useKeybind } from "../context/keybind"
import type { KeybindsConfig } from "@merakcode/sdk/client"

export function DialogKeys() {
  const { theme } = useTheme()
  const dialog = useDialog()
  const keybind = useKeybind()
  const locale = useLocale()

  // Groups of common keybinds; only bound keys are shown.
  const GROUPS: { title: string; keys: (keyof KeybindsConfig)[] }[] = [
    {
      title: locale.t("keys.input"),
      keys: [
        "agent_cycle",
        "agent_cycle_reverse",
        "permission_mode_cycle",
        "variant_cycle",
        "command_list",
        "input_submit",
        "input_clear",
      ],
    },
    {
      title: locale.t("keys.session"),
      keys: ["session_pin_toggle", "session_rename", "messages_undo", "messages_redo", "sidebar_toggle"],
    },
    {
      title: locale.t("keys.navigation"),
      keys: ["messages_first", "messages_last", "messages_page_up", "messages_page_down", "session_parent"],
    },
  ]

  const LABELS: Partial<Record<keyof KeybindsConfig, string>> = {
    agent_cycle: locale.t("keys.agentCycle"),
    agent_cycle_reverse: locale.t("keys.agentCycleReverse"),
    permission_mode_cycle: locale.t("keys.permissionModeCycle"),
    variant_cycle: locale.t("keys.variantCycle"),
    command_list: locale.t("keys.commandList"),
    input_submit: locale.t("keys.submit"),
    input_clear: locale.t("keys.inputClear"),
    session_pin_toggle: locale.t("keys.sessionPin"),
    session_rename: locale.t("keys.sessionRename"),
    messages_undo: locale.t("keys.undo"),
    messages_redo: locale.t("keys.redo"),
    sidebar_toggle: locale.t("keys.sidebarToggle"),
    messages_first: locale.t("keys.messagesFirst"),
    messages_last: locale.t("keys.messagesLast"),
    messages_page_up: locale.t("keys.messagesPageUp"),
    messages_page_down: locale.t("keys.messagesPageDown"),
    session_parent: locale.t("keys.sessionParent"),
  }

  useDialogKeyboard((evt) => {
    if (evt.name === "return" || evt.name === "escape") {
      dialog.clear()
    }
  })

  const rows = createMemo(() =>
    GROUPS.flatMap((group) => {
      const items = group.keys
        .map((key) => {
          const printed = keybind.print(key)
          if (!printed || printed === "none") return null
          const label = LABELS[key] ?? key
          return { key: printed, label }
        })
        .filter((x): x is { key: string; label: string } => x !== null)
      if (items.length === 0) return []
      return [{ title: group.title, items }]
    }),
  )

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {locale.t("keys.title")}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc/enter
        </text>
      </box>
      <box paddingBottom={1} gap={1}>
        <For each={rows()}>
          {(group) => (
            <box flexDirection="column" gap={0}>
              <text fg={theme.primary} attributes={TextAttributes.BOLD}>
                {group.title}
              </text>
              <For each={group.items}>
                {(item) => (
                  <box flexDirection="row" gap={2}>
                    <text fg={theme.text} flexShrink={0}>
                      {item.key}
                    </text>
                    <text fg={theme.textMuted}>{item.label}</text>
                  </box>
                )}
              </For>
            </box>
          )}
        </For>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme.primary} onMouseUp={() => dialog.clear()}>
          <text fg={theme.selectedListItemText}>{locale.t("common.confirm")}</text>
        </box>
      </box>
    </box>
  )
}
