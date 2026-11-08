import { locale } from "../../i18n"
import { explain } from "../../state/error"

export function noticeText(text: string) {
  const message = explain(text, locale())
  return message ? `${message.title} (${text})\n${message.hint}` : text
}
