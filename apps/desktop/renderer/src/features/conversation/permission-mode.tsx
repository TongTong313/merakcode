import { createSignal } from "solid-js"
import { t } from "../../i18n"
import { Confirm } from "../../ui/dialog"
import { Select } from "../../ui/select"

export type PermissionMode = "ask" | "auto" | "takeover"

export function PermissionModeSelect(props: {
  value: string
  disabled?: boolean
  onChange: (mode: PermissionMode) => void
}) {
  const [confirm, setConfirm] = createSignal(false)
  return (
    <>
      <Select
        label={t("permissionLevel.label")}
        value={props.value as PermissionMode}
        disabled={props.disabled}
        options={[
          { value: "ask", label: t("permissionLevel.ask"), description: t("permissionLevel.ask.desc") },
          {
            value: "auto",
            label: t("permissionLevel.autoApprove"),
            description: t("permissionLevel.autoApprove.desc"),
          },
          {
            value: "takeover",
            label: t("permissionLevel.fullTakeover"),
            description: t("permissionLevel.fullTakeover.desc"),
            tone: "danger",
            badge: t("permissionLevel.fullTakeover.badge"),
          },
        ]}
        onChange={(mode: PermissionMode) => {
          if (mode === "takeover") setConfirm(true)
          else props.onChange(mode)
        }}
      />
      <Confirm
        open={confirm()}
        title={t("permissionLevel.confirm.title")}
        description={t("permissionLevel.confirm.description")}
        danger
        confirm={t("permissionLevel.confirm.accept")}
        cancel={t("common.cancel")}
        onResult={(accepted) => {
          setConfirm(false)
          if (accepted) props.onChange("takeover")
        }}
      />
    </>
  )
}
