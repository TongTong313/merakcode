import type { CompactContext, FilterResult, OutputCompactionConfig } from "../types"

function isGitCommand(command: string, subcommand: string) {
  return new RegExp(`(^|[;&|]\\s*)git\\s+${subcommand}(\\s|$)`).test(command.trim())
}

function limitLines(lines: string[], maxLines: number, label: string) {
  if (lines.length <= maxLines) return lines
  return [...lines.slice(0, maxLines), `[+${lines.length - maxLines} ${label} omitted]`]
}

function isStatusHint(line: string) {
  return (
    line.startsWith('(use "git') ||
    line.startsWith("(create/copy files") ||
    line.includes('(use "git add') ||
    line.includes('(use "git restore') ||
    line.includes('(use "git rm') ||
    line.startsWith("  (use ")
  )
}

export function compactGitStatus(context: CompactContext, config: OutputCompactionConfig): FilterResult | null {
  if (!isGitCommand(context.command, "status")) return null
  if (/--porcelain\b|-z\b|--short\b/.test(context.command)) return null

  const lines = context.stdout.split(/\r?\n/)
  if (lines.length < 12) return null

  const out: string[] = []
  const keepHeaders = new Set([
    "Changes to be committed:",
    "Changes not staged for commit:",
    "Untracked files:",
    "Unmerged paths:",
  ])
  let section = ""
  let omitted = 0

  for (const raw of lines) {
    const trimmed = raw.trim()
    if (!trimmed) continue

    if (isStatusHint(trimmed)) {
      omitted++
      continue
    }

    if (
      trimmed.startsWith("On branch ") ||
      trimmed.startsWith("HEAD detached ") ||
      trimmed.startsWith("Your branch ") ||
      trimmed.startsWith("nothing to commit") ||
      trimmed.startsWith("no changes added") ||
      trimmed.startsWith("nothing added to commit")
    ) {
      out.push(trimmed)
      continue
    }

    if (keepHeaders.has(trimmed)) {
      section = trimmed
      out.push(trimmed)
      continue
    }

    if (
      /^(modified|new file|deleted|renamed|copied|both modified|both added|both deleted|added by us|deleted by them|deleted by us|added by them):\s+/.test(
        trimmed,
      )
    ) {
      out.push(`  ${trimmed}`)
      continue
    }

    if (section === "Untracked files:" && !trimmed.startsWith("(use ")) {
      out.push(`  ${trimmed}`)
      continue
    }

    omitted++
  }

  if (out.length === 0) return null
  const limited = limitLines(out, config.mode === "aggressive" ? 80 : 120, "status lines")
  if (omitted > 0) limited.push(`[${omitted} git status hint/prose lines omitted]`)

  return {
    filterName: "git-status",
    output: limited.join("\n"),
  }
}

type DiffFile = {
  name: string
  added: number
  removed: number
  lines: string[]
  omitted: number
  skipped: number
  shown: number
  inHunk: boolean
}

function flushSkipped(file: DiffFile | null) {
  if (!file || file.skipped === 0) return
  file.lines.push(`  ... (${file.skipped} low-signal lines omitted)`)
  file.omitted += file.skipped
  file.skipped = 0
}

function flushFile(file: DiffFile | null, out: string[]) {
  if (!file) return
  flushSkipped(file)
  out.push(file.name)
  out.push(...file.lines)
  if (file.added > 0 || file.removed > 0) out.push(`  +${file.added} -${file.removed}`)
  if (file.omitted > 0) out.push(`  [${file.omitted} diff lines omitted]`)
}

export function compactGitDiff(context: CompactContext, config: OutputCompactionConfig): FilterResult | null {
  if (!isGitCommand(context.command, "diff") && !isGitCommand(context.command, "show")) return null
  if (/--stat\b|--numstat\b|--shortstat\b|--name-only\b|--name-status\b/.test(context.command)) return null
  if (!context.stdout.includes("diff --git") && !context.stdout.includes("@@")) return null

  const maxOutputLines = config.mode === "aggressive" ? 260 : 500
  const maxHunkLines = config.mode === "aggressive" ? 60 : 100
  const out: string[] = []
  let current: DiffFile | null = null
  let stoppedEarly = false

  for (const line of context.stdout.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      flushFile(current, out)
      const match = /^diff --git a\/(.*?) b\/(.*)$/.exec(line)
      current = {
        name: match?.[2] ?? line.replace(/^diff --git\s+/, ""),
        added: 0,
        removed: 0,
        lines: [],
        omitted: 0,
        skipped: 0,
        shown: 0,
        inHunk: false,
      }
      continue
    }

    if (!current) {
      if (line.trim()) out.push(line)
      continue
    }

    if (line.startsWith("@@")) {
      flushSkipped(current)
      current.inHunk = true
      current.shown = 0
      current.lines.push(`  ${line}`)
      continue
    }

    if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("index ")) {
      current.omitted++
      continue
    }

    if (
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("rename from") ||
      line.startsWith("rename to") ||
      line.startsWith("similarity index")
    ) {
      current.lines.push(`  ${line}`)
      continue
    }

    if (!current.inHunk) continue

    const added = line.startsWith("+") && !line.startsWith("+++")
    const removed = line.startsWith("-") && !line.startsWith("---")
    const marker = line.startsWith("\\")
    const contextLine = !added && !removed && !marker && current.shown > 0

    if (added) current.added++
    if (removed) current.removed++

    if ((added || removed || contextLine) && current.shown < maxHunkLines) {
      current.lines.push(`  ${line}`)
      current.shown++
    } else if (line.trim() && !marker) {
      current.skipped++
      stoppedEarly = true
    }

    if (out.length + current.lines.length >= maxOutputLines) {
      stoppedEarly = true
      break
    }
  }

  flushFile(current, out)

  const limited = limitLines(out, maxOutputLines, "diff lines")
  if (stoppedEarly || limited.length < out.length) limited.push("[full diff preserved in raw output file]")
  if (limited.length === 0) return null

  return {
    filterName: "git-diff",
    output: limited.join("\n"),
  }
}

export function compactGitLog(context: CompactContext, config: OutputCompactionConfig): FilterResult | null {
  if (!isGitCommand(context.command, "log")) return null
  if (/--oneline\b|--format\b|--pretty\b/.test(context.command)) return null

  const lines = context.stdout.split(/\r?\n/)
  if (lines.length < 80) return null

  const maxCommits = config.mode === "aggressive" ? 20 : 40
  const totalCommits = lines.filter((line) => line.startsWith("commit ")).length
  const result: string[] = []
  let commitCount = 0
  let inCommit = false
  let keptMessage = false

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (line.startsWith("commit ")) {
      commitCount++
      if (commitCount > maxCommits) break
      result.push(line)
      inCommit = true
      keptMessage = false
      continue
    }

    if (!inCommit) continue
    const trimmed = line.trim()
    if (trimmed.startsWith("Author:") || trimmed.startsWith("Date:")) result.push(trimmed)
    else if (trimmed && !keptMessage) {
      result.push(`  ${trimmed}`)
      keptMessage = true
    }
  }

  if (totalCommits > maxCommits) result.push(`[+${totalCommits - maxCommits} commits omitted]`)
  if (result.length === 0) return null

  return {
    filterName: "git-log",
    output: result.join("\n"),
  }
}
