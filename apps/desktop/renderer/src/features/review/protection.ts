import z from "zod"
import { persistent } from "../../lib/persistence"
import { decodeDir, relative, sameDir } from "../../lib/route"
import { gitDirectory, registerDirty, resolveDirectory } from "../../state/git"

const managed = new Set<string>()
const recovered = new Map<string, Map<string, string>>()
const layoutSchema = z.object({
  version: z.literal(1),
  directory: z.string().optional(),
  tabs: z.array(z.unknown()),
})
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

/** Loaded controllers own their guards, including changes not yet acknowledged by storage. */
export function ownReviewProtection(owner: string) {
  managed.add(owner)
  for (const [directory, entries] of recovered)
    for (const [key, previous] of entries)
      if (previous === owner) {
        registerDirty(directory, key, 0)
        entries.delete(key)
      }
}

export async function restoreReviewProtection(directory: string) {
  directory = gitDirectory(directory)
  const next = new Map<string, string>()
  for (const bucket of await persistent.buckets()) {
    if (!bucket.startsWith("panels-")) continue
    const owner = decodeDir(bucket.slice("panels-".length))
    if (!owner || managed.has(owner)) continue
    const raw = (await persistent.entries(bucket)).find(([key]) => key === "layout")?.[1]
    if (!raw) continue
    const layout = layoutSchema.parse(JSON.parse(raw))
    for (const value of layout.tabs) {
      const tab = record(value)
      if (tab.kind !== "review" || typeof tab.id !== "string") continue
      const view = record(tab.view)
      const comments = Object.values(record(view.comments)).flatMap((value) => (Array.isArray(value) ? value : []))
      const drafts = Object.values(record(view.drafts))
        .map(record)
        .filter((draft) => typeof draft.text === "string" && !!draft.text.trim())
      const fallback = layout.directory ?? view.directory ?? (owner.startsWith("new:") ? owner.slice(4) : undefined)
      const locations = new Set(
        [...comments.map(record), ...drafts.map((draft) => record(draft.target))]
          .map((target) => target.directory ?? fallback)
          .filter((value): value is string => typeof value === "string"),
      )
      for (const location of locations) {
        const known = gitDirectory(location)
        if (!sameDir(known, directory)) {
          if (relative(directory, known) === known) continue
          if (!sameDir(await resolveDirectory(location), directory)) continue
        }
        if (!managed.has(owner)) next.set(`review-tab:${owner}:${tab.id}`, owner)
        break
      }
    }
  }
  for (const [key, owner] of new Map([...(recovered.get(directory) ?? []), ...next])) {
    if (managed.has(owner)) continue
    registerDirty(directory, key, next.has(key) ? 1 : 0)
  }
  recovered.set(directory, next)
}
