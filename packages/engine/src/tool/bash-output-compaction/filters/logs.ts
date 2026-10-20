import type { CompactContext, FilterResult, OutputCompactionConfig } from "../types"

const TIMESTAMP_RE = /^\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}[.,]?\d*\s*/
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g
const HEX_RE = /0x[0-9a-fA-F]+/g
const NUM_RE = /\b\d{4,}\b/g
const PATH_RE = /(?:[A-Za-z]:)?[\\/][\w.\-\\/]+/g

function normalize(line: string) {
  return line
    .replace(TIMESTAMP_RE, "")
    .replace(UUID_RE, "<UUID>")
    .replace(HEX_RE, "<HEX>")
    .replace(NUM_RE, "<NUM>")
    .replace(PATH_RE, "<PATH>")
    .trim()
}

function truncate(line: string, maxLen: number) {
  return line.length <= maxLen ? line : `${line.slice(0, maxLen - 3)}...`
}

function bump(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function top(title: string, counts: Map<string, number>, originals: Map<string, string>, maxItems: number) {
  if (counts.size === 0) return []
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const out = [title]
  for (const [normalized, count] of rows.slice(0, maxItems)) {
    const original = originals.get(normalized) ?? normalized
    out.push(`  ${count > 1 ? `[x${count}] ` : ""}${truncate(original, 140)}`)
  }
  if (rows.length > maxItems) out.push(`  [+${rows.length - maxItems} more unique lines omitted]`)
  return out
}

function looksLikeLogCommand(command: string) {
  return /(^|[;&|]\s*)(tail|journalctl|docker\s+logs|kubectl\s+logs|pm2\s+logs|cat\s+.*\.(log|out|err)|npm\s+run\s+(dev|start|serve)|pnpm\s+(dev|start)|yarn\s+(dev|start)|bun\s+run\s+(dev|start))(\s|$)/i.test(
    command.trim(),
  )
}

export function compactRepeatedLogs(context: CompactContext, config: OutputCompactionConfig): FilterResult | null {
  const lines = context.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length < 40) return null

  const errors = new Map<string, number>()
  const warnings = new Map<string, number>()
  const infos = new Map<string, number>()
  const errorOriginals = new Map<string, string>()
  const warningOriginals = new Map<string, string>()
  let severityLines = 0
  let adjacentRepeats = 0
  let previous = ""

  for (const line of lines) {
    if (line === previous) adjacentRepeats++
    previous = line

    const normalized = normalize(line)
    const lower = line.toLowerCase()
    if (/\b(error|fatal|panic|critical|alert|emerg|severe)\b/.test(lower)) {
      severityLines++
      if (!errorOriginals.has(normalized)) errorOriginals.set(normalized, line)
      bump(errors, normalized)
    } else if (/\b(warn|warning|notice)\b/.test(lower)) {
      severityLines++
      if (!warningOriginals.has(normalized)) warningOriginals.set(normalized, line)
      bump(warnings, normalized)
    } else if (/\binfo\b/.test(lower)) {
      severityLines++
      bump(infos, normalized)
    }
  }

  if (severityLines === 0 && adjacentRepeats < 5 && !looksLikeLogCommand(context.command)) return null

  const totalErrors = [...errors.values()].reduce((sum, value) => sum + value, 0)
  const totalWarnings = [...warnings.values()].reduce((sum, value) => sum + value, 0)
  const totalInfos = [...infos.values()].reduce((sum, value) => sum + value, 0)
  const result = [
    "Log Summary",
    `  error: ${totalErrors} (${errors.size} unique)`,
    `  warn: ${totalWarnings} (${warnings.size} unique)`,
    `  info: ${totalInfos} (${infos.size} unique)`,
    `  lines: ${lines.length}`,
    "",
    ...top("[ERRORS]", errors, errorOriginals, config.mode === "aggressive" ? 8 : 12),
  ]

  if (errors.size > 0 && warnings.size > 0) result.push("")
  result.push(...top("[WARNINGS]", warnings, warningOriginals, config.mode === "aggressive" ? 5 : 8))

  if (totalErrors === 0 && totalWarnings === 0) {
    result.push("", "[TAIL]", ...lines.slice(-(config.mode === "aggressive" ? 20 : 40)))
  }

  return {
    filterName: "logs",
    output: result.filter((line, index, arr) => !(line === "" && arr[index - 1] === "")).join("\n"),
  }
}
