import z from "zod"
import { MerakCodeError } from "../../state/error"
import { t } from "../../i18n"
import { persistent } from "../../lib/persistence"
import { decodeDir } from "../../lib/route"
import { gitDirectory, registerDirty } from "../../state/git"
import { sameRecoveryDirectory } from "../code/identity"
import { commentTargetSchema } from "./selection"

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

async function* savedReviews() {
  for (const bucket of await persistent.buckets()) {
    if (!bucket.startsWith("panels-")) continue
    const owner = decodeDir(bucket.slice("panels-".length))
    if (!owner) continue
    const raw = (await persistent.entries(bucket)).find(([key]) => key === "layout")?.[1]
    if (!raw) continue
    const layout = (() => {
      try {
        return layoutSchema.parse(JSON.parse(raw))
      } catch (cause) {
        throw new MerakCodeError({ code: "MRK-4026", message: t("panel.restoreError"), cause })
      }
    })()
    for (const value of layout.tabs) {
      const tab = record(value)
      if (tab.kind !== "review" || typeof tab.id !== "string") continue
      const view = record(tab.view)
      const comments = Object.values(record(view.comments)).flatMap((value) => (Array.isArray(value) ? value : []))
      const drafts = Object.values(record(view.drafts))
        .map(record)
        .filter((draft) => typeof draft.text === "string" && !!draft.text.trim())
      const fallback = layout.directory ?? view.directory ?? (owner.startsWith("new:") ? owner.slice(4) : undefined)
      const targets = [...comments.map(record), ...drafts.map((draft) => record(draft.target))]
      const locations = new Set(
        targets
          .map((target) => target.directory ?? fallback)
          .filter((value): value is string => typeof value === "string"),
      )
      const confirmed = targets.flatMap((target) => {
        const parsed = commentTargetSchema.safeParse(target)
        return parsed.success ? [parsed.data.directory] : []
      })
      yield { owner, key: `review-tab:${owner}:${tab.id}`, directory: fallback, locations, confirmed }
    }
  }
}

export async function storedReviewDirectories() {
  const directories: { directory?: string; targets: string[]; confirmed: string[] }[] = []
  for await (const review of savedReviews()) {
    if (!review.locations.size) continue
    directories.push({
      directory: typeof review.directory === "string" ? review.directory : undefined,
      targets: [...review.locations],
      confirmed: review.confirmed,
    })
  }
  return directories
}

export async function restoreReviewProtection(directory: string) {
  directory = gitDirectory(directory)
  const next = new Map<string, string>()
  for await (const review of savedReviews()) {
    if (managed.has(review.owner)) continue
    for (const location of review.locations) {
      // A folder that cannot be reached and was never confirmed stays with its own owner; it must not stop other
      // folders from loading their branches
      const same = await sameRecoveryDirectory(location, directory).catch((error: unknown) => {
        if (error instanceof MerakCodeError && error.code === "MRK-5023") return false
        throw error
      })
      if (!same) continue
      if (!managed.has(review.owner)) next.set(review.key, review.owner)
      break
    }
  }
  for (const [key, owner] of new Map([...(recovered.get(directory) ?? []), ...next])) {
    if (managed.has(owner)) continue
    registerDirty(directory, key, next.has(key) ? 1 : 0)
  }
  recovered.set(directory, next)
}
