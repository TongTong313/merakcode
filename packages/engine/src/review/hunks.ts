/**
 * Pure hunk operations for review: splits the changes between two texts into hunks the way git does (3 lines of
 * context on each side, changes at most 6 lines apart merge into one hunk), and applies or reverts only some of them.
 *
 * Accepting hunks moves the base to compose(base, current, accepted); rejecting hunks reverts the current text to
 * revert(base, current, rejected). An undefined text means the file does not exist. Comparison ignores CRLF vs LF
 * (like git with autocrlf, a line ending difference alone is not a change). The output is built on the target side;
 * lines taken from the other side get the target file's line ending, and a missing final newline is preserved.
 */
import { createHash } from "node:crypto"
import { diffArrays } from "diff"

const CONTEXT = 3

export type HunkLine = {
  kind: "context" | "add" | "del"
  /** Without the line ending */
  text: string
  /** Line number before the change; absent for added lines */
  old?: number
  /** Line number after the change; absent for deleted lines */
  new?: number
  /** The last line of the file, without a trailing newline */
  noNewline?: true
}

export type Hunk = {
  /**
   * Content hash of deleted lines + added lines + occurrence among identical hunks; stays the same when other parts of
   * the base or current text change
   */
  id: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** Nearest unindented declaration above the hunk, same as git's default funcname rule */
  heading?: string
  lines: HunkLine[]
}

/**
 * A run of equal lines (each side keeps its original text, which may differ only in line endings), or a change that
 * replaces old with new
 */
type Segment = { change: boolean; old: string[]; new: string[] }

function split(text: string | undefined) {
  return text ? (text.match(/[^\n]*\n|[^\n]+$/g) ?? []) : []
}

const normal = (line: string) => line.replace(/\r\n$/, "\n")

function segments(before: string[], after: string[]) {
  const out: Segment[] = []
  const pos = { old: 0, new: 0 }
  for (const part of diffArrays(before, after, { comparator: (a, b) => normal(a) === normal(b) })) {
    const count = part.count ?? part.value.length
    const take = (side: "old" | "new") => {
      const source = side === "old" ? before : after
      const result = source.slice(pos[side], pos[side] + count)
      pos[side] += count
      return result
    }
    if (!part.added && !part.removed) {
      out.push({ change: false, old: take("old"), new: take("new") })
      continue
    }
    const last = out.at(-1)
    const entry = last?.change ? last : { change: true, old: [], new: [] }
    if (entry !== last) out.push(entry)
    if (part.removed) entry.old.push(...take("old"))
    else entry.new.push(...take("new"))
  }
  return out
}

/** Groups changes into hunks: returns the segment indexes of each hunk */
function groups(list: Segment[]) {
  const result: number[][] = []
  list.forEach((segment, index) => {
    if (!segment.change) return
    const current = result.at(-1)
    const gap = current ? list.slice(current.at(-1)! + 1, index).reduce((sum, item) => sum + item.old.length, 0) : 0
    if (current && gap <= CONTEXT * 2) current.push(index)
    else result.push([index])
  })
  return result
}

function strip(line: string) {
  return line.replace(/\r?\n$/, "")
}

function heading(lines: string[], before: number) {
  for (let index = before - 1; index >= 0; index--) {
    const text = strip(lines[index]!)
    if (/^[A-Za-z_$]/.test(text)) return text.slice(0, 120)
  }
}

type Built = { hunk: Hunk; segments: number[] }

function build(before: string | undefined, after: string | undefined): Built[] {
  if (before === after) return []
  const oldLines = split(before)
  const newLines = split(after)
  const list = segments(oldLines, newLines)
  // Creating or deleting an empty file has no lines, but existence changed, so it is one hunk
  if (!list.some((segment) => segment.change) && (before === undefined) !== (after === undefined))
    list.push({ change: true, old: [], new: [] })

  // Start index of each segment in the old and new text
  const starts: { old: number; new: number }[] = []
  list.reduce(
    (pos, segment) => {
      starts.push(pos)
      return { old: pos.old + segment.old.length, new: pos.new + segment.new.length }
    },
    { old: 0, new: 0 },
  )

  const seen = new Map<string, number>()
  return groups(list).map((indexes) => {
    const first = indexes[0]!
    const last = indexes.at(-1)!
    const lines: HunkLine[] = []
    const line = (kind: HunkLine["kind"], raw: string, old?: number, next?: number): HunkLine => ({
      kind,
      text: strip(raw),
      ...(old !== undefined ? { old } : {}),
      ...(next !== undefined ? { new: next } : {}),
      ...(raw.endsWith("\n") ? {} : { noNewline: true }),
    })
    const context = (oldAt: number, newAt: number, count: number) => {
      for (let i = 0; i < count; i++) lines.push(line("context", oldLines[oldAt + i]!, oldAt + i + 1, newAt + i + 1))
    }

    const lead = Math.min(CONTEXT, starts[first]!.old)
    context(starts[first]!.old - lead, starts[first]!.new - lead, lead)
    for (let index = first; index <= last; index++) {
      const segment = list[index]!
      const at = starts[index]!
      if (!segment.change) {
        context(at.old, at.new, segment.old.length)
        continue
      }
      segment.old.forEach((raw, i) => lines.push(line("del", raw, at.old + i + 1)))
      segment.new.forEach((raw, i) => lines.push(line("add", raw, undefined, at.new + i + 1)))
    }
    const end = { old: starts[last]!.old + list[last]!.old.length, new: starts[last]!.new + list[last]!.new.length }
    context(end.old, end.new, Math.min(CONTEXT, oldLines.length - end.old))

    const removed = indexes.flatMap((index) => list[index]!.old.map(normal)).join("")
    const added = indexes.flatMap((index) => list[index]!.new.map(normal)).join("")
    const key = `${removed}\u0000${added}`
    const occurrence = seen.get(key) ?? 0
    seen.set(key, occurrence + 1)

    const oldCount = lines.filter((item) => item.kind !== "add").length
    const newCount = lines.filter((item) => item.kind !== "del").length
    const oldStart = starts[first]!.old - lead
    const newStart = starts[first]!.new - lead
    return {
      segments: indexes,
      hunk: {
        id: createHash("sha1").update(`${key}\u0000${occurrence}`).digest("hex").slice(0, 16),
        // Like git: when a hunk has no old lines, the start is the line before the insertion point
        oldStart: oldCount ? oldStart + 1 : oldStart,
        oldLines: oldCount,
        newStart: newCount ? newStart + 1 : newStart,
        newLines: newCount,
        heading: heading(oldLines, oldStart),
        lines,
      },
    }
  })
}

export function hunks(before: string | undefined, after: string | undefined): Hunk[] {
  return build(before, after).map((item) => item.hunk)
}

/** Line ending used by most lines; undefined when no line has one */
function dominant(lines: string[]) {
  const crlf = lines.filter((line) => line.endsWith("\r\n")).length
  const lf = lines.filter((line) => line.endsWith("\n")).length - crlf
  if (crlf + lf === 0) return
  return crlf > lf ? "\r\n" : "\n"
}

/**
 * Builds on the base side: hunks in keep use the changed lines, other hunks use the original lines.
 * Lines taken from the other side get the base side's line ending.
 */
function mix(before: string | undefined, after: string | undefined, keep: Set<string>, base: "old" | "new") {
  const built = build(before, after)
  if (built.length === 0) return base === "old" ? before : after
  if (before === undefined || after === undefined) return keep.has(built[0]!.hunk.id) ? after : before
  const kept = new Set(built.filter((item) => keep.has(item.hunk.id)).flatMap((item) => item.segments))
  const eol = dominant(split(base === "old" ? before : after))
  return segments(split(before), split(after))
    .map((segment, index) => {
      if (!segment.change) return segment[base].join("")
      const side = kept.has(index) ? "new" : "old"
      if (side === base || !eol) return segment[side].join("")
      return segment[side].map((line) => (line.endsWith("\n") ? strip(line) + eol : line)).join("")
    })
    .join("")
}

/** Applies only the hunks in keep on top of before (accept); undefined means the file does not exist */
export function compose(before: string | undefined, after: string | undefined, keep: Set<string>) {
  return mix(before, after, keep, "old")
}

/** Reverts only the hunks in drop from after (reject); undefined means the file does not exist */
export function revert(before: string | undefined, after: string | undefined, drop: Set<string>) {
  const keep = new Set(hunks(before, after).flatMap((hunk) => (drop.has(hunk.id) ? [] : [hunk.id])))
  return mix(before, after, keep, "new")
}
