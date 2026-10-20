import { TextAttributes } from "@opentui/core"
import { For } from "solid-js"
import { useTheme } from "../../context/theme"
import { useLocale } from "../../context/locale"

export function DiffViewerHelpDialog() {
  const { theme } = useTheme()
  const locale = useLocale()

  const rows = [
    { key: "h", action: locale.t("diff.help.help.action"), desc: locale.t("diff.help.help.desc") },
    { key: "q", action: locale.t("diff.help.close.action"), desc: locale.t("diff.help.close.desc") },
    { key: "tab", action: locale.t("diff.help.focus.action"), desc: locale.t("diff.help.focus.desc") },
    { key: "[ / ]", action: locale.t("diff.help.hunk.action"), desc: locale.t("diff.help.hunk.desc") },
    { key: "n / p", action: locale.t("diff.help.file.action"), desc: locale.t("diff.help.file.desc") },
    { key: "t", action: locale.t("diff.help.tree.action"), desc: locale.t("diff.help.tree.desc") },
    { key: "1", action: locale.t("diff.help.single.action"), desc: locale.t("diff.help.single.desc") },
    { key: "s", action: locale.t("diff.help.source.action"), desc: locale.t("diff.help.source.desc") },
    { key: "v", action: locale.t("diff.help.view.action"), desc: locale.t("diff.help.view.desc") },
    { key: "m", action: locale.t("diff.help.reviewed.action"), desc: locale.t("diff.help.reviewed.desc") },
  ]

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {locale.t("diff.help.title")}
        </text>
        <text fg={theme.textMuted}>h / esc</text>
      </box>
      <box flexDirection="row">
        <text fg={theme.textMuted} width={8} wrapMode="none">
          {locale.t("diff.help.colKey")}
        </text>
        <text fg={theme.textMuted} width={22} wrapMode="none">
          {locale.t("diff.help.colAction")}
        </text>
        <text fg={theme.textMuted}>{locale.t("diff.help.colDesc")}</text>
      </box>
      <For each={rows}>
        {(row) => (
          <box flexDirection="row">
            <text fg={theme.text} width={8} wrapMode="none">
              {row.key}
            </text>
            <text fg={theme.text} width={22} wrapMode="none">
              {row.action}
            </text>
            <text fg={theme.textMuted}>{row.desc}</text>
          </box>
        )}
      </For>
    </box>
  )
}
