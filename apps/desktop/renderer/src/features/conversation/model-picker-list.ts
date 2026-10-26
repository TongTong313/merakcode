import { providerLabel } from "../../ui/provider-label"

export type PickerEntry = {
  provider: { id: string; name: string; origin?: "official" | "configured" }
  model: { id: string; name: string; homepage?: boolean }
  key: string
}

export type PickerSection = { id: "configured" | "official"; title: string; items: PickerEntry[] }

/** Official section first, then configured. The current model stays first in its own section. An empty section is omitted. */
export function pickerSections(
  items: PickerEntry[],
  current: string | undefined,
  titles: { configured: string; official: string },
  query = "",
): PickerSection[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = (item: PickerEntry) => item.model.homepage === true || item.key === current
  const matched = items.filter(shown).filter((item) => {
    const haystack = [
      item.model.name,
      item.model.id,
      item.provider.id,
      item.provider.name,
      providerLabel(item.provider, "zh"),
      providerLabel(item.provider, "en"),
    ]
      .join(" ")
      .toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
  return (["official", "configured"] as const).flatMap((id) => {
    const mine = matched.filter((item) => (item.provider.origin === "official") === (id === "official"))
    if (!mine.length) return []
    const pinned = current ? mine.find((item) => item.key === current) : undefined
    const rest = pinned ? mine.filter((item) => item !== pinned) : mine
    return [{ id, title: titles[id], items: pinned ? [pinned, ...rest] : rest }]
  })
}
