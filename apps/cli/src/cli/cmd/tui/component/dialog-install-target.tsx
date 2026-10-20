import { TextAttributes } from "@opentui/core"
import { useTheme, selectedForeground } from "../context/theme"
import { useDialog, useDialogKeyboard } from "../ui/dialog"
import { useLocale } from "../context/locale"
import { createSignal } from "solid-js"
import { availableInstallTarget, installTargetAvailable, type SkillInstallTarget } from "./dialog-skills-core"

export type InstallTarget = SkillInstallTarget

export type InstallTargetDialogProps = {
  skillName: string
  title?: string
  showDescriptions?: boolean
  disabledTargets?: InstallTarget[]
  onSelect: (target: InstallTarget) => void
  onCancel: () => void
}

export function InstallTargetDialog(props: InstallTargetDialogProps) {
  const dialog = useDialog()
  const locale = useLocale()
  const { theme } = useTheme()
  const fg = selectedForeground(theme)
  const disabled = () => props.disabledTargets ?? []
  const enabled = (target: InstallTarget) => installTargetAvailable(target, disabled())

  const [selected, setSelected] = createSignal<InstallTarget>(availableInstallTarget(disabled()))

  useDialogKeyboard((evt) => {
    if (evt.name === "up" || evt.name === "k") {
      if (enabled("project")) setSelected("project")
    } else if (evt.name === "down" || evt.name === "j") {
      if (enabled("global")) setSelected("global")
    } else if (evt.name === "return") {
      if (!enabled(selected())) return
      props.onSelect(selected())
      dialog.pop()
    } else if (evt.name === "escape") {
      props.onCancel()
      dialog.pop()
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      {/* Title */}
      <box flexDirection="row" justifyContent="space-between" alignItems="center">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title ?? locale.t("skills.install.target", { name: props.skillName })}
        </text>
        <text
          fg={theme.textMuted}
          onMouseUp={() => {
            props.onCancel()
            dialog.pop()
          }}
        >
          esc
        </text>
      </box>

      {/* Project target */}
      <box
        flexDirection="row"
        gap={2}
        alignItems="center"
        paddingLeft={1}
        paddingTop={1}
        paddingBottom={1}
        backgroundColor={selected() === "project" && enabled("project") ? theme.primary : undefined}
        onMouseUp={() => {
          if (!enabled("project")) return
          setSelected("project")
          props.onSelect("project")
          dialog.pop()
        }}
      >
        <text
          fg={!enabled("project") ? theme.textMuted : selected() === "project" ? fg : theme.text}
          attributes={TextAttributes.BOLD}
        >
          ●
        </text>
        <text fg={!enabled("project") ? theme.textMuted : selected() === "project" ? fg : theme.text}>
          {locale.t("skills.remoteMarket.target.project")}
        </text>
        {!enabled("project") && <text fg={theme.textMuted}>[{locale.t("skills.skillhub.installed")}]</text>}
        {props.showDescriptions !== false && (
          <text fg={selected() === "project" && enabled("project") ? fg : theme.textMuted}>
            ({locale.t("skills.remoteMarket.target.projectDesc")})
          </text>
        )}
      </box>

      {/* Global target */}
      <box
        flexDirection="row"
        gap={2}
        alignItems="center"
        paddingLeft={1}
        paddingTop={1}
        paddingBottom={1}
        backgroundColor={selected() === "global" && enabled("global") ? theme.primary : undefined}
        onMouseUp={() => {
          if (!enabled("global")) return
          setSelected("global")
          props.onSelect("global")
          dialog.pop()
        }}
      >
        <text
          fg={!enabled("global") ? theme.textMuted : selected() === "global" ? fg : theme.text}
          attributes={TextAttributes.BOLD}
        >
          ●
        </text>
        <text fg={!enabled("global") ? theme.textMuted : selected() === "global" ? fg : theme.text}>
          {locale.t("skills.remoteMarket.target.global")}
        </text>
        {!enabled("global") && <text fg={theme.textMuted}>[{locale.t("skills.skillhub.installed")}]</text>}
        {props.showDescriptions !== false && (
          <text fg={selected() === "global" && enabled("global") ? fg : theme.textMuted}>
            ({locale.t("skills.remoteMarket.target.globalDesc")})
          </text>
        )}
      </box>

      {/* Key hints */}
      <box flexDirection="row" gap={2} paddingTop={1}>
        <text fg={theme.primary}>↑↓</text>
        <text fg={theme.textMuted}>{locale.t("keys.navigation")}</text>
        <text fg={theme.primary}>enter</text>
        <text fg={theme.textMuted}>{locale.t("common.confirm")}</text>
        <text fg={theme.primary}>esc</text>
        <text fg={theme.textMuted}>{locale.t("common.cancel")}</text>
      </box>
    </box>
  )
}

/**
 * Shows the install target picker.
 * @param dialog dialog context
 * @param skillName name of the skill being installed
 * @returns the chosen target, or null if cancelled
 */
InstallTargetDialog.show = (
  dialog: import("../ui/dialog").DialogContext,
  skillName: string,
  title?: string,
  showDescriptions?: boolean,
  disabledTargets?: InstallTarget[],
): Promise<InstallTarget | null> => {
  return new Promise((resolve) => {
    dialog.push(
      () => (
        <InstallTargetDialog
          skillName={skillName}
          title={title}
          showDescriptions={showDescriptions}
          disabledTargets={disabledTargets}
          onSelect={(target) => {
            resolve(target)
          }}
          onCancel={() => {
            resolve(null)
          }}
        />
      ),
      () => {
        resolve(null)
      },
    )
  })
}
