import { createMemo, createResource, onMount } from "solid-js"
import { useSync } from "../../context/sync"
import { useSDK } from "../../context/sdk"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import type { TextPart } from "@merakcode/sdk/client"
import { Locale } from "@merakcode/util/locale"
import { DialogMessage } from "./dialog-message"
import { useDialog } from "../../ui/dialog"
import type { PromptInfo } from "../../component/prompt/history"
import { useLocale } from "../../context/locale"

export function DialogTimeline(props: {
  sessionID: string
  onMove: (messageID: string) => void
  setPrompt?: (promptInfo: PromptInfo) => void
}) {
  const sync = useSync()
  const sdk = useSDK()
  const dialog = useDialog()
  const locale = useLocale()

  onMount(() => {
    dialog.setSize("large")
    // Load all messages into the sync store so the session view can find any older message when an entry is picked.
    // The timeline list itself also uses the full endpoint, so the store's 100-message cap does not apply.
    void sync.session.loadAll(props.sessionID)
  })

  // Fetch all messages (no limit) so user prompts in long sessions are not lost.
  const [data] = createResource(async () => {
    const res = await sdk.client.session.messages({ sessionID: props.sessionID })
    return res.data ?? []
  })

  const options = createMemo((): DialogSelectOption<string>[] => {
    const messages = data() ?? []
    const result = [] as DialogSelectOption<string>[]
    for (const { info: message, parts } of messages) {
      if (message.role !== "user") continue
      const part = parts.find((x) => x.type === "text" && !x.synthetic && !x.ignored) as TextPart | undefined
      if (!part) continue
      result.push({
        title: part.text.replace(/\n/g, " "),
        value: message.id,
        footer: Locale.time(message.time.created),
        onSelect: (dialog) => {
          dialog.replace(() => (
            <DialogMessage messageID={message.id} sessionID={props.sessionID} setPrompt={props.setPrompt} />
          ))
        },
      })
    }
    result.reverse()
    return result
  })

  return (
    <DialogSelect
      onMove={(option) => props.onMove(option.value)}
      title={locale.t("dialog.timeline")}
      options={data.loading ? [] : options()}
    />
  )
}
