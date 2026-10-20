import type { AssistantMessage, Message, Part, ToolPart, UserMessage } from "@merakcode/sdk/client"
import { diffLines } from "diff"

export type Turn = { user: UserMessage; replies: AssistantMessage[] }

/**
 * Groups messages into turns: a user message plus the assistant messages replying to it (matched by parentID, or the
 * previous turn when there is no match). Leading assistant messages with no user message (e.g. left after compaction)
 * go into orphans.
 */
export function turns(messages: readonly Message[]) {
  const list: Turn[] = []
  const orphans: AssistantMessage[] = []
  const index = new Map<string, Turn>()
  for (const message of messages) {
    if (message.role === "user") {
      const turn = { user: message, replies: [] }
      list.push(turn)
      index.set(message.id, turn)
      continue
    }
    const turn = index.get(message.parentID) ?? list.at(-1)
    if (turn) turn.replies.push(message)
    else orphans.push(message)
  }
  return { turns: list, orphans }
}

/** Exploration tools such as reads and searches; consecutive calls are shown as one step */
const EXPLORE = new Set(["read", "grep", "glob", "list", "ls", "codesearch"])
/** Parts not shown on their own in a message */
const HIDDEN = new Set(["step-start", "step-finish", "snapshot", "patch", "agent", "subtask"])

export type Block = { kind: "part"; part: Part } | { kind: "explore"; parts: ToolPart[] }

export function blocks(parts: readonly Part[]): Block[] {
  const result: Block[] = []
  for (const part of parts) {
    if (HIDDEN.has(part.type)) continue
    if (part.type === "text" && (part.synthetic || !part.text.trim())) continue
    if (part.type === "reasoning" && !part.text.trim()) continue
    if (part.type === "tool" && EXPLORE.has(part.tool)) {
      const last = result.at(-1)
      if (last?.kind === "explore") last.parts.push(part)
      else result.push({ kind: "explore", parts: [part] })
      continue
    }
    result.push({ kind: "part", part })
  }
  return result
}

/** How many files an exploration step read and how many searches it ran */
export function explored(parts: readonly ToolPart[]) {
  const reads = new Set(
    parts.filter((part) => part.tool === "read").map((part) => String(part.state.input.filePath ?? "")),
  )
  return { reads: reads.size, searches: parts.length - parts.filter((part) => part.tool === "read").length }
}

/** Edit tools (write / edit / multi_edit) whose changes are recorded */
const EDITS = new Set(["write", "edit", "multi_edit"])
type FileDiff = { file?: string; before?: string; after?: string }

/**
 * Files changed in this turn. A file edited several times is counted from before the first edit to after the last;
 * files edited back to their original content are skipped.
 */
export function changes(parts: readonly Part[]) {
  const files = new Map<string, { before: string; after: string }>()
  for (const part of parts) {
    if (part.type !== "tool" || !EDITS.has(part.tool) || part.state.status !== "completed") continue
    const diff = part.state.metadata.filediff as FileDiff | undefined
    const file = diff?.file ?? String(part.state.input.filePath ?? "")
    if (!file || diff?.after === undefined) continue
    const existing = files.get(file)
    files.set(file, { before: existing?.before ?? diff.before ?? "", after: diff.after })
  }
  return [...files]
    .flatMap(([file, { before, after }]) => {
      if (before === after) return []
      const parts = diffLines(before, after)
      const count = (kind: "added" | "removed") =>
        parts.reduce((sum, item) => sum + (item[kind] ? (item.count ?? 0) : 0), 0)
      return [{ file, additions: count("added"), deletions: count("removed") }]
    })
    .toSorted((a, b) => a.file.localeCompare(b.file))
}
