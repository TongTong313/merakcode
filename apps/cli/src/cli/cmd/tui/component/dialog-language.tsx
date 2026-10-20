import { DialogSelect } from "../ui/dialog-select"
import { useLocale } from "../context/locale"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"

export function DialogLanguage() {
  const locale = useLocale()
  const dialog = useDialog()
  const toast = useToast()

  const options = locale.all().map((value) => ({
    title: locale.t(`language.${value.replace("-", "")}`),
    value: value,
  }))

  return (
    <DialogSelect
      title={locale.t("dialog.selectLanguage")}
      options={options}
      current={locale.current}
      onSelect={(opt) => {
        dialog.clear()
        void locale
          .switchLocale(opt.value as "zh-CN" | "en-US")
          .catch(() => toast.show({ message: locale.t("error.languageSaveFailed"), variant: "error" }))
      }}
    />
  )
}
