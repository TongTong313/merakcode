import { createMemo } from "solid-js"
import { useLocal } from "../context/local"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useLocale } from "../context/locale"

export function DialogAgent() {
  const local = useLocal()
  const dialog = useDialog()
  const locale = useLocale()

  const options = createMemo(() =>
    local.agent.list().map((item) => {
      return {
        value: item.name,
        title: item.name,
        description: item.native ? locale.t("common.native") : item.description,
      }
    }),
  )

  return (
    <DialogSelect
      title={locale.t("dialog.selectAgent")}
      current={local.agent.current().name}
      options={options()}
      onSelect={(option) => {
        local.agent.set(option.value)
        dialog.clear()
      }}
    />
  )
}
