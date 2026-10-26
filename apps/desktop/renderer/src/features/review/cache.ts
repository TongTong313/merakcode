/**
 * Rules for the review cache (see state.ts), kept pure so they can be tested: which list a request belongs to, which
 * details are still valid, when files open on their own, what to prefetch and how much of a file to render.
 */
import type { ReviewFile, ReviewFileDetail, ReviewScope } from "@merakcode/sdk/client"

/** What identifies one review list */
export type ReviewKey = {
  directory: string
  scope: ReviewScope
  sessionID?: string
  messageID?: string
  base?: string
  checkout?: string | null
}

export const keyOf = (input: ReviewKey) =>
  [
    input.directory,
    input.scope,
    input.sessionID ?? "",
    input.messageID ?? "",
    input.base ?? "",
    input.checkout ?? "",
  ].join("\u0000")

/**
 * Details stay valid while the file's content version and its accepted count are the same (accepting in the branch
 * scope only marks hunks, which changes the count but not the content)
 */
export const detailKey = (list: string, file: ReviewFile) =>
  [list, file.file, file.version, file.accepted].join("\u0000")

/** Small reviews open every file; larger ones start collapsed and load a file when it is opened */
const AUTO_EXPAND = { files: 5, lines: 300 }

export const autoExpand = (files: ReviewFile[]) =>
  files.length <= AUTO_EXPAND.files &&
  files.reduce((sum, file) => sum + file.additions + file.deletions, 0) <= AUTO_EXPAND.lines

/** Background prefetch after a list arrives: at most this many files, skipping huge ones, until bytes is reached */
export const PREFETCH = { files: 20, fileLines: 2_000, bytes: 2 * 1024 * 1024, concurrency: 2 }

/** Files to prefetch, in list order */
export function prefetchQueue(files: ReviewFile[], cached: (file: ReviewFile) => boolean) {
  return files
    .filter((file) => !file.binary && !file.truncated && file.additions + file.deletions <= PREFETCH.fileLines)
    .filter((file) => !cached(file))
    .slice(0, PREFETCH.files)
}

/** Approximate size of a detail, counted against the prefetch budget */
export const detailSize = (detail: ReviewFileDetail) =>
  (detail.before?.length ?? 0) +
  (detail.after?.length ?? 0) +
  detail.hunks.reduce((sum, hunk) => sum + hunk.lines.reduce((total, line) => total + line.text.length + 1, 0), 0)

/** Lines rendered per file before "show the rest" */
const SHOWN_LINES = 300

/** How many lines of each hunk fit in the budget; hunks after it show nothing until the rest is shown */
export function budget(hunks: { lines: unknown[] }[], limit = SHOWN_LINES) {
  let left = limit
  return hunks.map((hunk) => {
    const take = Math.min(hunk.lines.length, Math.max(0, left))
    left -= take
    return take
  })
}
