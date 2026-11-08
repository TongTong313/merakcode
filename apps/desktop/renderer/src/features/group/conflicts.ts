import type { BoardCard } from "@merakcode/sdk"

/** Integration tasks refer to the original claim's merge result. */
export function conflictFiles(card: BoardCard, cards: BoardCard[]) {
  if (card.status === "done" || card.status === "cancelled") return []
  const own = Object.values(card.merges ?? {}).filter((merge) => merge.status === "conflicted")
  const original = cards
    .flatMap((item) => Object.values(item.merges ?? {}))
    .filter((merge) => merge.claim === card.integrationOf && merge.status === "conflicted")
  return [...new Set([...own, ...original].flatMap((merge) => merge.conflicts ?? []))]
}
