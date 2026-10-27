import type { ReviewFileDetail, ReviewLine, ReviewScope } from "@merakcode/sdk/client"
import { t } from "../../i18n"

export type SelectedLine = ReviewLine & { hunk: string; index: number }
export type CommentTarget = {
  key: string
  directory: string
  sessionID: string
  scope: ReviewScope
  messageID?: string
  branch?: string | null
  file: string
  version: string
  side: "old" | "new" | "unified"
  rows: SelectedLine[]
  editing?: number
  relocating?: string
  stale?: boolean
}

export function commentLocation(target: CommentTarget) {
  const range = (side: "old" | "new") => {
    const numbers = target.rows.flatMap((row) => (row[side] === undefined ? [] : [row[side]]))
    if (!numbers.length) return ""
    const start = Math.min(...numbers)
    const end = Math.max(...numbers)
    return `${start}${end !== start ? `–${end}` : ""}`
  }
  const old = range("old")
  const next = range("new")
  if (target.side === "old" || !next) return `${target.file}:${t("review.oldSide")} ${old}`
  if (target.side === "unified" && old && target.rows.some((row) => row.kind === "del"))
    return `${target.file}:${t("review.oldSide")} ${old} / ${t("review.newSide")} ${next}`
  return `${target.file}:${next}`
}

export const excerptOf = (target: CommentTarget) =>
  target.rows.map((row) => `${row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "}${row.text}`).join("\n")

/** Relocate only when the exact selected code has one unambiguous match in this file. */
export function refreshTarget<T extends CommentTarget>(target: T, detail: ReviewFileDetail): T {
  if (target.stale || target.version === detail.version) return target
  const lines = detail.hunks
    .flatMap((hunk) => hunk.lines.map((line, index) => ({ ...line, hunk: hunk.id, index })))
    .filter(
      (line) => target.side === "unified" || (target.side === "old" ? line.old !== undefined : line.new !== undefined),
    )
  const matches = lines.flatMap((_, index) =>
    target.rows.every(
      (row, offset) => row.kind === lines[index + offset]?.kind && row.text === lines[index + offset]?.text,
    )
      ? [index]
      : [],
  )
  if (matches.length !== 1) return { ...target, stale: true }
  return { ...target, version: detail.version, rows: lines.slice(matches[0], matches[0]! + target.rows.length) }
}
