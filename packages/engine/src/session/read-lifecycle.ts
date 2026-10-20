/**
 * Read lifecycle (projection layer).
 *
 * Before messages go to the LLM, each Read is classified by whether its content is still valid, and invalid output
 * is replaced:
 * - STALE: the same file was edited/written after this Read, so the content is outdated and would mislead the model
 * - SUPERSEDED: the same file was read again later with a covering line range, so this Read is redundant
 * - FRESH: neither; left as is
 *
 * Independent of prune (persistent, position-based eviction when space runs out) and lossless (folds redundancy
 * within a single output). They can be combined: a read may be folded by lossless and also be stale here.
 *
 * Why a projection instead of persistence: states change over time (fresh when read, stale after an edit). Recomputing
 * every turn handles that naturally and keeps the original data intact. Pruned reads (state.time.compacted set) are
 * skipped.
 *
 * Prompt cache: replacing a read changes history and breaks the cache the first time. Replacement is monotonic (stale
 * stays stale, the marker is fixed), so the cache stabilizes again on later turns. The recentTurns window
 * approximates a frozen region: recent reads are not replaced, to avoid breaking the cache repeatedly.
 * TODO: once the provider's cache token counts feed into this decision, use an exact frozen region instead of turns.
 */

import path from "path"
import { Config } from "../config/config"
import { Message } from "./message"
import { SessionContextBudget } from "./context-budget"

export type ReadLifecycleConfig = {
  enabled: boolean
  /** Replace STALE reads (outdated content, a correctness issue). Should stay on. */
  stale: boolean
  /** Replace SUPERSEDED reads (redundant content, only saves space) */
  superseded: boolean
  /** Read outputs smaller than this are kept; the marker itself takes bytes, so tiny outputs are not worth it */
  minSizeBytes: number
  /**
   * Protected window: reads within the last N user turns are not replaced, to avoid breaking the prompt cache often.
   * Leaving recent stale reads alone is the accepted cost of a stable cache (see the TODO at the top of this file).
   */
  recentTurns: number
}

export const DEFAULT_READ_LIFECYCLE_CONFIG: ReadLifecycleConfig = {
  enabled: true,
  stale: true,
  superseded: true,
  minSizeBytes: 500,
  recentTurns: SessionContextBudget.RECENT_TURNS,
}

type ReadState = "fresh" | "stale" | "superseded"

/** A file operation in message order, used to decide whether a read is stale or redundant */
type FileOp = {
  filePath: string
  operation: "read" | "edit"
  msgIndex: number
  partIndex: number
  /** Read only: the line range, used for the superseded coverage check */
  readOffset?: number
  readLimit?: number
}

/**
 * Normalizes a file path: relative paths are resolved against cwd and separators become forward slashes.
 * The forward slashes matter: read's input.filePath may be an absolute path with forward slashes while
 * edit/write/multi_edit may pass relative paths, and path.resolve returns backslashes on Windows. Without
 * normalization the same file would not match and classification would miss it.
 */
function normalize(filePath: string, cwd: string) {
  if (!filePath) return ""
  return path.resolve(cwd, filePath).split(path.sep).join("/")
}

/**
 * Extracts file operations from a ToolPart: one each for read/edit/write/multi_edit.
 * apply_patch has been removed; old sessions' calls to it are not parsed as edits (matching the UI).
 * Other tools yield nothing (fail-open, other classifications are unaffected).
 */
function extractOps(part: Message.ToolPart, msgIndex: number, partIndex: number, cwd: string): FileOp[] {
  if (part.state.status !== "completed") return []
  const input = part.state.input ?? {}
  const tool = part.tool

  if (tool === "read") {
    const filePath = normalize(input.filePath, cwd)
    if (!filePath) return []
    return [{ filePath, operation: "read", msgIndex, partIndex, readOffset: input.offset, readLimit: input.limit }]
  }

  if (tool === "edit" || tool === "write" || tool === "multi_edit") {
    const filePath = normalize(input.filePath, cwd)
    if (!filePath) return []
    return [{ filePath, operation: "edit", msgIndex, partIndex }]
  }

  return []
}

/**
 * Whether the later read fully covers the earlier read's line range.
 * A whole-file read (no offset/limit) covers everything; a partial read only covers a range contained in its own.
 * The default limit of 2000 matches ReadTool.
 */
function readCovers(later: FileOp, earlier: FileOp): boolean {
  if (later.readOffset == null && later.readLimit == null) return true
  if (earlier.readOffset == null && earlier.readLimit == null) return false
  const laterStart = later.readOffset ?? 0
  const laterEnd = laterStart + (later.readLimit ?? 2000)
  const earlierStart = earlier.readOffset ?? 0
  const earlierEnd = earlierStart + (earlier.readLimit ?? 2000)
  return laterStart <= earlierStart && laterEnd >= earlierEnd
}

/** Classifies one read. stale wins over superseded: it is a correctness issue and its marker is more specific. */
function classify(read: FileOp, ops: FileOp[], config: ReadLifecycleConfig): ReadState {
  const edits = ops.filter((o) => o.operation === "edit")
  if (config.stale && edits.some((e) => e.msgIndex > read.msgIndex)) return "stale"

  if (config.superseded) {
    const reads = ops.filter((o) => o.operation === "read")
    if (reads.some((r) => r.msgIndex > read.msgIndex && readCovers(r, read))) return "superseded"
  }

  return "fresh"
}

function marker(state: ReadState, filePath: string): string {
  const display = filePath || "unknown"
  if (state === "stale") {
    return `[Read content stale: ${display} was modified after this read - re-read for current content.]`
  }
  return `[Read content superseded: ${display} was re-read later - re-read if needed.]`
}

/** Whether a Read output was replaced by this layer: only the marker sentence, no file content. */
export function isLifecycleReplacement(output: string) {
  return output.startsWith("[Read content stale:") || output.startsWith("[Read content superseded:")
}

/**
 * Boundary of the protected window: reads with msgIndex >= boundary (the last N user turns) are not replaced.
 * Returns messages.length when recentTurns <= 0 (everything replaceable), and 0 with fewer than N turns (all kept).
 */
function protectionBoundary(messages: Message.FullMsg[], recentTurns: number): number {
  if (recentTurns <= 0) return messages.length
  let turns = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info.role === "user") {
      turns++
      if (turns >= recentTurns) return i
    }
  }
  return 0
}

/**
 * Applies the replacements to deltaMessages and returns a new array. Changed parts are copied; the input array and
 * storage are untouched. cwd resolves relative paths (read/edit input.filePath may be relative).
 */
export function applyReadLifecycle(
  messages: Message.FullMsg[],
  config: ReadLifecycleConfig,
  cwd: string,
): Message.FullMsg[] {
  if (!config.enabled) return messages
  if (messages.length === 0) return messages

  const boundary = protectionBoundary(messages, config.recentTurns)

  // Single pass: index FileOps by filePath and collect the reads.
  const fileOps = new Map<string, FileOp[]>()
  const readParts: FileOp[] = []

  for (let mi = 0; mi < messages.length; mi++) {
    const parts = messages[mi].parts
    for (let pi = 0; pi < parts.length; pi++) {
      const part = parts[pi]
      if (part.type !== "tool") continue
      // Pruned parts already hold the placeholder.
      if (part.state.status === "completed" && part.state.time?.compacted) continue

      const ops = extractOps(part, mi, pi, cwd)
      for (const op of ops) {
        let bucket = fileOps.get(op.filePath)
        if (!bucket) {
          bucket = []
          fileOps.set(op.filePath, bucket)
        }
        bucket.push(op)
        if (op.operation === "read") readParts.push(op)
      }
    }
  }

  if (readParts.length === 0) return messages

  // Classify and collect parts to replace, skipping the protected window and small outputs.
  const replacements = new Map<string, ReadState>()
  for (const read of readParts) {
    const ops = fileOps.get(read.filePath)
    if (!ops) continue
    const state = classify(read, ops, config)
    if (state === "fresh") continue
    if (read.msgIndex >= boundary) continue

    const part = messages[read.msgIndex].parts[read.partIndex]
    if (part.type !== "tool" || part.state.status !== "completed") continue
    const output = part.state.output ?? ""
    if (Buffer.byteLength(output, "utf8") < config.minSizeBytes) continue

    replacements.set(`${read.msgIndex}:${read.partIndex}`, state)
  }

  if (replacements.size === 0) return messages

  // Copy only the messages and parts that change.
  return messages.map((msg, mi) => {
    let touched = false
    const newParts = msg.parts.map((part, pi) => {
      const state = replacements.get(`${mi}:${pi}`)
      if (!state || part.type !== "tool" || part.state.status !== "completed") return part
      touched = true
      return {
        ...part,
        state: { ...part.state, output: marker(state, normalize(part.state.input?.filePath ?? "", cwd)) },
      }
    })
    return touched ? { ...msg, parts: newParts } : msg
  })
}

type ReadLifecycleUserConfig =
  | boolean
  | {
      enabled?: boolean
      stale?: boolean
      superseded?: boolean
      min_size_bytes?: number
      recent_turns?: number
    }

/** Resolves the user config into a full config; unset options use the defaults (everything on) */
export function resolveReadLifecycleConfig(config: ReadLifecycleUserConfig | undefined): ReadLifecycleConfig {
  const object = typeof config === "object" ? config : undefined
  const configuredEnabled = typeof config === "boolean" ? config : object?.enabled
  return {
    enabled: configuredEnabled ?? true,
    stale: object?.stale ?? true,
    superseded: object?.superseded ?? true,
    minSizeBytes: object?.min_size_bytes ?? DEFAULT_READ_LIFECYCLE_CONFIG.minSizeBytes,
    recentTurns: object?.recent_turns ?? DEFAULT_READ_LIFECYCLE_CONFIG.recentTurns,
  }
}

export async function getConfiguredReadLifecycleConfig(): Promise<ReadLifecycleConfig> {
  const config = await Config.get()
  return resolveReadLifecycleConfig(config.compaction?.read_lifecycle as ReadLifecycleUserConfig | undefined)
}
