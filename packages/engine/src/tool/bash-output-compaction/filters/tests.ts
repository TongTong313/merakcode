import type { CompactContext, FilterResult, OutputCompactionConfig } from "../types"

function looksLikeTestCommand(command: string) {
  return /(^|[;&|]\s*)(pytest|python\s+-m\s+pytest|python3\s+-m\s+pytest|npm\s+test|pnpm\s+test|yarn\s+test|bun\s+test|jest|vitest|cargo\s+test|go\s+test)(\s|$)/.test(
    command.trim(),
  )
}

function truncate(line: string, maxLen: number) {
  const trimmed = line.trim()
  return trimmed.length <= maxLen ? trimmed : `${trimmed.slice(0, maxLen - 3)}...`
}

function compactGenericTestOutput(output: string, config: OutputCompactionConfig) {
  const lines = output.split(/\r?\n/)
  const important: string[] = []
  let omitted = 0
  const importantRe =
    /(FAIL|FAILED|ERROR|Error:|AssertionError|panic:|thread '.*' panicked|expected|received|Actual|Expected|short test summary|test result:|\d+\s+failed|\d+\s+passed|\d+\s+pass|\d+\s+fail)/i

  for (const line of lines) {
    if (importantRe.test(line)) important.push(truncate(line, 220))
    else omitted++
  }

  const tail = lines
    .slice(-(config.mode === "aggressive" ? 40 : 80))
    .filter((line) => line.trim())
    .map((line) => truncate(line, 220))

  const combined = [...important]
  for (const line of tail) {
    if (!combined.includes(line)) combined.push(line)
  }

  const maxLines = config.mode === "aggressive" ? 120 : 200
  const limited = combined.slice(0, maxLines)
  if (combined.length > maxLines) limited.push(`[+${combined.length - maxLines} important test lines omitted]`)
  if (omitted > 0) limited.push(`[${omitted} routine test output lines omitted]`)
  return limited.length > 0 ? limited.join("\n") : null
}

export function compactTestOutput(context: CompactContext, config: OutputCompactionConfig): FilterResult | null {
  if (!looksLikeTestCommand(context.command)) return null

  const lines = context.stdout.split(/\r?\n/)
  const threshold = config.mode === "aggressive" ? 80 : 120
  if (lines.length <= threshold) return null

  const output = compactGenericTestOutput(context.stdout, config)
  if (!output) return null

  return {
    filterName: "test-output",
    output,
  }
}
