import { Clipboard } from "./clipboard"
import { I18n } from "../../../i18n"

type Toast = {
  show: (input: { message: string; variant: "info" | "success" | "warning" | "error" }) => void
  error: (err: unknown) => void
}

type Renderer = {
  getSelection: () => { getSelectedText: () => string } | null
  clearSelection: () => void
}

export namespace Selection {
  export function copy(renderer: Renderer, toast: Toast): boolean {
    const text = renderer.getSelection()?.getSelectedText()
    if (!text) return false

    Clipboard.copy(text)
      .then(() => toast.show({ message: I18n.t("common.copied"), variant: "info" }))
      .catch(toast.error)

    renderer.clearSelection()
    return true
  }
}
