import type { CompactContext, FilterResult, OutputCompactionConfig } from "../types"

function looksLikePackageManagerCommand(command: string) {
  return /(^|[;&|]\s*)(npm|pnpm|yarn|bun)\s+(install|i|add|remove|update|upgrade|audit|ci)(\s|$)/.test(command.trim())
}

function truncate(line: string, maxLen = 180) {
  const trimmed = line.trim()
  return trimmed.length <= maxLen ? trimmed : `${trimmed.slice(0, maxLen - 3)}...`
}

function pushUnique(list: string[], line: string, max = 20) {
  const value = truncate(line)
  if (value && !list.includes(value) && list.length < max) list.push(value)
}

export function compactPackageManagerOutput(
  context: CompactContext,
  config: OutputCompactionConfig,
): FilterResult | null {
  if (!looksLikePackageManagerCommand(context.command)) return null

  const lines = context.stdout.split(/\r?\n/).filter((line) => line.trim())
  if (lines.length < 25) return null

  const summary: string[] = []
  const warnings: string[] = []
  const errors: string[] = []
  const vulnerabilities: string[] = []
  const lifecycle: string[] = []

  for (const raw of lines) {
    const line = raw.trim()
    const lower = line.toLowerCase()
    if (/\b(added|removed|changed|updated|audited|installed)\b.*\b(packages?|dependencies?)\b/.test(lower)) {
      pushUnique(summary, line)
    } else if (
      /\bpackages? are looking for funding\b|\bfound \d+ vulnerabilities\b|\b\d+ vulnerabilities?\b/.test(lower)
    ) {
      pushUnique(summary, line)
    } else if (/\b(low|moderate|high|critical)\b.*\bvulnerabilit/.test(lower)) {
      pushUnique(vulnerabilities, line)
    } else if (/\bdeprecated\b|\bwarn(?:ing)?\b|^npm warn|^warning\b|^warn\b/.test(lower)) {
      pushUnique(warnings, line, config.mode === "aggressive" ? 10 : 20)
    } else if (/\b(err|error|failed|enoent|eresolve|eacces|conflict)\b|^npm err!|^error\b/.test(lower)) {
      pushUnique(errors, line, 30)
    } else if (/\b(postinstall|preinstall|prepare|build|node-gyp|scripts?)\b/.test(lower)) {
      pushUnique(lifecycle, line, 12)
    }
  }

  if (
    summary.length === 0 &&
    warnings.length === 0 &&
    errors.length === 0 &&
    vulnerabilities.length === 0 &&
    lifecycle.length === 0
  ) {
    return null
  }

  const result = [`Package manager: ${context.command.replace(/\s+/g, " ").trim()}`]
  if (summary.length > 0) result.push("", "Summary:", ...summary.map((line) => `  ${line}`))
  if (vulnerabilities.length > 0) result.push("", "Vulnerabilities:", ...vulnerabilities.map((line) => `  ${line}`))
  if (errors.length > 0) result.push("", "Errors:", ...errors.map((line) => `  ${line}`))
  if (warnings.length > 0) result.push("", "Warnings:", ...warnings.map((line) => `  ${line}`))
  if (lifecycle.length > 0) result.push("", "Lifecycle/build lines:", ...lifecycle.map((line) => `  ${line}`))
  result.push("", `[${Math.max(0, lines.length - result.length)} package-manager output lines omitted]`)

  return {
    filterName: "package-manager",
    output: result.join("\n"),
  }
}
