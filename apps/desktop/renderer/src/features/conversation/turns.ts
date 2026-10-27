import type { Message, Part, ToolPart } from "@merakcode/sdk/client"
import { diffLines } from "diff"

export type UserInfo = Extract<Message, { role: "user" }>
export type AssistantInfo = Extract<Message, { role: "assistant" }>
export type Turn = { user: UserInfo; replies: AssistantInfo[] }

/**
 * Groups messages into turns: a user message plus the assistant messages replying to it (matched by parentID, or the
 * previous turn when there is no match). Leading assistant messages with no user message (e.g. left after compaction)
 * go into orphans.
 */
export function turns(messages: readonly Message[]) {
  const list: Turn[] = []
  const orphans: AssistantInfo[] = []
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

/** A stretch of a group chat turn: the leader's own blocks, or one member's delegate call */
export type Segment = { kind: "leader"; blocks: Block[] } | { kind: "seat"; part: ToolPart }

/** Splits the leader's parts at each delegate call, so every member's reply reads as a message of its own */
export function segments(parts: readonly Part[]): Segment[] {
  const result: Segment[] = []
  let pending: Part[] = []
  const flush = () => {
    const list = blocks(pending)
    if (list.length) result.push({ kind: "leader", blocks: list })
    pending = []
  }
  for (const part of parts) {
    if (part.type !== "tool" || part.tool !== "delegate") {
      pending.push(part)
      continue
    }
    flush()
    result.push({ kind: "seat", part })
  }
  flush()
  return result
}

/**
 * Members whose delegation has started and not finished; a queued one is still waiting. A stopped turn leaves its calls
 * reading as running, so nobody counts as working once the turn is over.
 */
export function working(parts: readonly Part[], busy: boolean) {
  const ids = new Set<string>()
  if (!busy) return ids
  for (const part of parts) {
    if (part.type !== "tool" || part.tool !== "delegate" || part.state.status !== "running") continue
    const metadata = part.state.metadata ?? {}
    if (typeof metadata.seatID === "string" && metadata.phase !== "queued") ids.add(metadata.seatID)
  }
  return ids
}

/** Events by turn: slot i holds the events before turn i starts, the last slot those after the last turn started */
export function eventsByTurn<T extends { at: number }>(events: readonly T[], starts: readonly number[]): T[][] {
  const slots: T[][] = [...starts.map(() => []), []]
  for (const event of events) {
    const index = starts.findIndex((start) => start > event.at)
    slots[index < 0 ? starts.length : index]!.push(event)
  }
  return slots
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
