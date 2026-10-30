import { getConfiguredOutputCompactionConfig, getOutputCompactionConfig } from "./config"
import { applyOutputFilters } from "./registry"
import { applySessionDelta, clearSessionDeltaCache } from "./session-delta"
import type { CompactContext, CompactFileContext, CompactResult, OutputCompactionConfig } from "./types"
import { Filesystem } from "@merakcode/util/filesystem"

function byteLength(text: string) {
  return Buffer.byteLength(text, "utf8")
}

function looksBinary(stdout: string) {
  if (stdout.includes("\u0000")) return true
  const sample = stdout.slice(0, 4096)
  let control = 0
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i)
    if (code < 32 && ![9, 10, 13, 27].includes(code)) control++
  }
  return sample.length > 0 && control / sample.length > 0.02
}

function looksStructured(command: string, stdout: string) {
  if (/--json\b|--format\s+json\b|--format=json\b|-z\b|--null\b|--porcelain\b/.test(command)) return true
  const trimmed = stdout.trimStart()
  if (!trimmed) return false
  if (trimmed.startsWith("{")) return true
  if (/^\[\s*(?:\]|\{|"|\d|true|false|null)/.test(trimmed.slice(0, 80))) return true
  return /^[-\w]+:\s/m.test(trimmed) && /\n\s+[-\w]+:\s/m.test(trimmed)
}

function header(filterName: string, originalBytes: number, compactedBytes: number, rawOutputPath?: string) {
  const saved = Math.max(0, originalBytes - compactedBytes)
  return [
    `[output compacted: ${filterName}, ${originalBytes} -> ${compactedBytes} bytes, saved ${saved} bytes]`,
    ...(rawOutputPath ? [`[full output saved: ${rawOutputPath}]`] : []),
  ].join("\n")
}

function withHeader(
  context: CompactContext,
  config: OutputCompactionConfig,
  filterName: string,
  output: string,
  originalBytes: number,
): CompactResult | null {
  const rawOutputPath = context.persistedOutputPath
  const bodyBytes = byteLength(output)
  const content = `${header(filterName, originalBytes, bodyBytes, rawOutputPath)}\n${output}`
  const compactedBytes = byteLength(content)

  if (compactedBytes >= originalBytes) return null
  if (compactedBytes > config.maxCompactedBytes) return null

  return {
    output: content,
    filterName,
    originalBytes,
    compactedBytes,
    rawOutputPath,
  }
}

export function compactBashOutput(context: CompactContext, config = getOutputCompactionConfig()): CompactResult | null {
  const originalBytes = byteLength(context.stdout)

  if (!config.enabled) return null
  if (originalBytes < config.minBytes) return null
  if (looksBinary(context.stdout)) return null
  if (looksStructured(context.command, context.stdout)) return null

  if (config.sessionDelta) {
    const delta = applySessionDelta(context)
    if (delta) return withHeader(context, config, "session-delta", delta, originalBytes)
  }

  const filtered = applyOutputFilters(context, config)
  if (!filtered) return null

  return withHeader(context, config, filtered.filterName, filtered.output, originalBytes)
}

export async function compactBashOutputFile(
  context: CompactFileContext,
  config = getOutputCompactionConfig(),
): Promise<CompactResult | null> {
  if (!config.enabled) return null
  if (context.outputSize < config.minBytes) return null
  if (context.outputSize > config.maxInputBytes) return null

  const stdout = await Filesystem.readText(context.outputPath)
  return compactBashOutput(
    {
      command: context.command,
      cwd: context.cwd,
      sessionID: context.sessionID,
      exitCode: context.exitCode,
      stdout,
      persistedOutputPath: context.outputPath,
      persistedOutputSize: context.outputSize,
    },
    config,
  )
}

export { clearSessionDeltaCache, getConfiguredOutputCompactionConfig, getOutputCompactionConfig }
export type { CompactContext, CompactFileContext, CompactResult, OutputCompactionConfig } from "./types"
