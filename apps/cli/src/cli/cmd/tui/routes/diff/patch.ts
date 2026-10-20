import { formatPatch, structuredPatch } from "diff"
import type { FileDiff as SnapshotFileDiff } from "@merakcode/sdk/client"

/** Converts the before/after of a session.diff entry into a unified patch for the <diff> renderable. */
export function snapshotToPatch(item: SnapshotFileDiff) {
  return formatPatch(structuredPatch(item.file, item.file, item.before, item.after, "", "", { context: 3 }))
}

export function snapshotToVcsDiff(item: SnapshotFileDiff) {
  return {
    file: item.file,
    patch: snapshotToPatch(item),
    additions: item.additions,
    deletions: item.deletions,
    status: item.status ?? "modified",
    ...("truncated" in item && item.truncated ? { truncated: true as const } : {}),
  }
}
