import { For } from "solid-js"
import { useTheme } from "../context/theme"
import { logo } from "../../../logo"

export function Logo() {
  const { theme } = useTheme()

  return (
    <box>
      <For each={logo.lines}>
        {(line) => (
          <text fg={theme.primary} selectable={false}>
            {line}
          </text>
        )}
      </For>
    </box>
  )
}
