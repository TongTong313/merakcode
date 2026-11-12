import type { GitChange } from "@merakcode/sdk"
import { structuredPatch } from "diff"

export type ReviewScope = "turn" | "session"
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
export type ReviewResult = {
  scope: ReviewScope
  checkout: string | null
  /** What the person may do with these changes; a review against a commit can only be read */
  actions: { accept: boolean; reject: boolean }
  /** The latest decision, which undo takes back */
  last?: { decision: "accept" | "reject"; count: number }
  files: ReviewFile[]
}

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

const linesOf = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? []

/**
 * The text a decision on some hunks of a file gives. Accepting makes the chosen hunks part of the starting point:
 * the "before" text with their new lines. Rejecting takes them back out of the working file: the "after" text with
 * their old lines. Both are cut from the real texts, so line endings and a missing final newline stay as they are.
 */
export function hunkText(decision: "accept" | "reject", detail: ReviewFileDetail, ids: string[]) {
  const from = linesOf((decision === "accept" ? detail.before : detail.after) ?? "")
  const to = linesOf((decision === "accept" ? detail.after : detail.before) ?? "")
  // A range that holds no lines starts after the line its hunk names; one that holds lines starts at it
  const range = (start: number, count: number) => [count === 0 ? start : start - 1, count] as const
  const chosen = detail.hunks.filter((hunk) => ids.includes(hunk.id))
  const result = [...from]
  for (const hunk of chosen.toSorted((a, b) =>
    decision === "accept" ? b.oldStart - a.oldStart : b.newStart - a.newStart,
  )) {
    const [at, count] = range(
      decision === "accept" ? hunk.oldStart : hunk.newStart,
      decision === "accept" ? hunk.oldLines : hunk.newLines,
    )
    const [source, length] = range(
      decision === "accept" ? hunk.newStart : hunk.oldStart,
      decision === "accept" ? hunk.newLines : hunk.oldLines,
    )
    result.splice(at, count, ...to.slice(source, source + length))
  }
  return result.join("")
}
