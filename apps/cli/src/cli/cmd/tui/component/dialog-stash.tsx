import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { createMemo, createSignal } from "solid-js"
import { Locale } from "@merakcode/util/locale"
import { useTheme } from "../context/theme"
import { useKeybind } from "../context/keybind"
import { usePromptStash, type StashEntry } from "./prompt/stash"
import { useLocale } from "../context/locale"

function getRelativeTime(timestamp: number, locale: ReturnType<typeof useLocale>): string {
  const now = Date.now()
  const diff = now - timestamp
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (seconds < 60) return locale.t("common.justNow")
  if (minutes < 60) return locale.t("common.minutesAgo", { minutes })
  if (hours < 24) return locale.t("common.hoursAgo", { hours })
  if (days < 7) return locale.t("common.daysAgo", { days })
  return Locale.datetime(timestamp)
}

function getStashPreview(input: string, maxLength: number = 50): string {
  const firstLine = input.split("\n")[0].trim()
  return Locale.truncate(firstLine, maxLength)
}

export function DialogStash(props: { onSelect: (entry: StashEntry) => void }) {
  const dialog = useDialog()
  const stash = usePromptStash()
  const { theme } = useTheme()
  const keybind = useKeybind()
  const locale = useLocale()

  const [toDelete, setToDelete] = createSignal<number>()

  const options = createMemo(() => {
    const entries = stash.list()
    // Show most recent first
    return entries
      .map((entry, index) => {
        const isDeleting = toDelete() === index
        const lineCount = (entry.input.match(/\n/g)?.length ?? 0) + 1
        return {
          title: isDeleting
            ? locale.t("stash.deleteConfirm", { key: keybind.print("stash_delete") })
            : getStashPreview(entry.input),
          bg: isDeleting ? theme.error : undefined,
          value: index,
          description: getRelativeTime(entry.timestamp, locale),
          footer: lineCount > 1 ? locale.t("common.lines", { count: lineCount }) : undefined,
        }
      })
      .toReversed()
  })

  return (
    <DialogSelect
      title={locale.t("dialog.stash")}
      options={options()}
      onMove={() => {
        setToDelete(undefined)
      }}
      onSelect={(option) => {
        const entries = stash.list()
        const entry = entries[option.value]
        if (entry) {
          stash.remove(option.value)
          props.onSelect(entry)
        }
        dialog.clear()
      }}
      keybind={[
        {
          keybind: keybind.all.stash_delete?.[0],
          title: locale.t("common.delete"),
          onTrigger: (option) => {
            if (toDelete() === option.value) {
              stash.remove(option.value)
              setToDelete(undefined)
              return
            }
            setToDelete(option.value)
          },
        },
      ]}
    />
  )
}
