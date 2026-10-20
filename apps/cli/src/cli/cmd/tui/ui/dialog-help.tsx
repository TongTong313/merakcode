import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog, useDialogKeyboard } from "./dialog"
import { useKeybind } from "../context/keybind"
import { useLocale } from "../context/locale"

export function DialogHelp() {
  const dialog = useDialog()
  const locale = useLocale()
  const { theme } = useTheme()
  const keybind = useKeybind()

  useDialogKeyboard((evt) => {
    if (evt.name === "return" || evt.name === "escape") {
      dialog.clear()
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {locale.t("help.title")}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc/enter
        </text>
      </box>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>{locale.t("help.commandListHint", { keybind: keybind.print("command_list") })}</text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme.primary} onMouseUp={() => dialog.clear()}>
          <text fg={theme.selectedListItemText}>{locale.t("common.confirm")}</text>
        </box>
      </box>
    </box>
  )
}
