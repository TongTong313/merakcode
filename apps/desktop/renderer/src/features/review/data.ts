import type { GitChange } from "@merakcode/sdk"
import { structuredPatch } from "diff"

export type ReviewScope = "session"
export type ReviewLine = { kind: "context" | "add" | "del"; text: string; old?: number; new?: number }
export type ReviewHunk = {
  id: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  heading?: string
  lines: ReviewLine[]
}
export type ReviewFile = {
  file: string
  status: string
  additions: number
  deletions: number
  hunks: number
  version: string
  binary?: boolean
  truncated?: boolean
}
export type ReviewFileDetail = { file: string; version: string; before?: string; after?: string; hunks: ReviewHunk[] }
export type ReviewResult = { scope: ReviewScope; checkout: string | null; files: ReviewFile[] }

/** Converts repository contents into the existing review presentation model. */
export function reviewData(changes: GitChange[]) {
  const files: ReviewFile[] = []
  const details: Record<string, ReviewFileDetail> = {}
  for (const change of changes) {
    const hunks: ReviewHunk[] = change.binary
      ? []
      : structuredPatch(change.oldPath ?? change.path, change.path, change.before, change.after).hunks.map(
          (hunk, index) => {
            let old = hunk.oldStart
            let next = hunk.newStart
            const lines: ReviewLine[] = []
            for (const line of hunk.lines) {
              const text = line.slice(1)
              if (line[0] === " ") lines.push({ kind: "context", text, old: old++, new: next++ })
              if (line[0] === "-") lines.push({ kind: "del", text, old: old++ })
              if (line[0] === "+") lines.push({ kind: "add", text, new: next++ })
            }
            return {
              id: `${change.version}:${index}`,
              oldStart: hunk.oldStart,
              oldLines: hunk.oldLines,
              newStart: hunk.newStart,
              newLines: hunk.newLines,
              lines,
            }
          },
        )
    const lines = hunks.flatMap((hunk) => hunk.lines)
    files.push({
      file: change.path,
      status: change.status,
      additions: lines.filter((line) => line.kind === "add").length,
      deletions: lines.filter((line) => line.kind === "del").length,
      hunks: hunks.length,
      version: change.version,
      binary: change.binary,
    })
    details[change.path] = {
      file: change.path,
      version: change.version,
      before: change.before,
      after: change.after,
      hunks,
    }
  }
  return { files, details }
}
