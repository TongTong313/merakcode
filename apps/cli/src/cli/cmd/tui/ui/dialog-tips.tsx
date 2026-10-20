import { useLocale } from "../context/locale"
import { TextAttributes } from "@opentui/core"
import { For } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog, useDialogKeyboard } from "./dialog"
import { DEFAULT_THEMES } from "../context/theme"

const TIPS_COUNT = 32
const themeCount = Object.keys(DEFAULT_THEMES).length

type TipPart = { text: string; highlight: boolean }

function parse(tip: string): TipPart[] {
  const regex = /\{highlight\}(.*?)\{\/highlight\}/g
  const found = Array.from(tip.matchAll(regex))
  const state = found.reduce(
    (acc, match) => {
      const start = match.index ?? 0
      if (start > acc.index) {
        acc.parts.push({ text: tip.slice(acc.index, start), highlight: false })
      }
      acc.parts.push({ text: match[1], highlight: true })
      acc.index = start + match[0].length
      return acc
    },
    { parts: [] as TipPart[], index: 0 },
  )

  if (state.index < tip.length) {
    state.parts.push({ text: tip.slice(state.index), highlight: false })
  }

  return state.parts
}

export function DialogTips() {
  const dialog = useDialog()
  const locale = useLocale()
  const { theme } = useTheme()
  const index = Math.floor(Math.random() * TIPS_COUNT)
  const tip = locale.t(`tips.${index}`, { count: themeCount })
  const parts = parse(tip)

  useDialogKeyboard((evt) => {
    if (evt.name === "return" || evt.name === "escape") {
      dialog.clear()
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.warning}>
          ● {locale.t("tips.title")}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc/enter
        </text>
      </box>
      <box paddingBottom={1}>
        <text fg={theme.text}>
          <For each={parts}>
            {(part) => <span style={{ fg: part.highlight ? theme.text : theme.textMuted }}>{part.text}</span>}
          </For>
        </text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme.primary} onMouseUp={() => dialog.clear()}>
          <text fg={theme.selectedListItemText}>{locale.t("common.confirm")}</text>
        </box>
      </box>
    </box>
  )
}
