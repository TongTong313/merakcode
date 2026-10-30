import type { CompactContext, FilterResult, OutputCompactionConfig } from "../types"

function commandContains(command: string, names: string[]) {
  return new RegExp(`(^|[;&|]\\s*)(${names.join("|")})(\\s|$)`).test(command.trim())
}

function headTail(lines: string[], maxLines: number, label: string) {
  if (lines.length <= maxLines) return lines
  const head = Math.ceil(maxLines * 0.75)
  const tail = maxLines - head
  return [...lines.slice(0, head), `[+${lines.length - maxLines} ${label} omitted]`, ...lines.slice(-tail)]
}

export function compactListingOutput(context: CompactContext, config: OutputCompactionConfig): FilterResult | null {
  if (!commandContains(context.command, ["ls", "tree", "find", "rg", "grep", "ag", "ack"])) return null
  if (/--json\b|-z\b|--null\b|-0\b|-print0\b/.test(context.command)) return null

  const lines = context.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0)
  const threshold = config.mode === "aggressive" ? 80 : 120
  if (lines.length <= threshold) return null

  const maxLines = config.mode === "aggressive" ? 120 : 220
  const label = commandContains(context.command, ["rg", "grep", "ag", "ack"]) ? "matches" : "entries"
  return {
    filterName: `listing-${label}`,
    output: [`${lines.length} ${label}:`, ...headTail(lines, maxLines, label)].join("\n"),
  }
}
