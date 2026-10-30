/**
 * Lossless compaction: reversible folding applied when a tool result is produced, to reduce the bytes that enter
 * the context.
 *
 * Division of work with bash-output-compaction (lossy summaries, off by default):
 * - This layer loses no information, is on by default and runs first; content that would otherwise be truncated
 *   is folded but kept in full
 * - The lossy layer does real summarizing (e.g. logs into statistics) and must be enabled explicitly
 * - Truncate only cuts output when neither layer applies
 *
 * Safety: each transform is round-trip checked on its own and skipped if it cannot be restored exactly or does not
 * shrink the text, without affecting the other transforms. Any exception falls back to no compaction; this never
 * throws.
 *
 * Prompt cache: this runs once when the tool result is produced and the message is never changed afterwards, so the
 * prefix stays stable and the cache is not invalidated the way rewriting history would.
 */

import { stripAnsi } from "./ansi"
import { foldRepeatedBlocks, unfoldRepeatedBlocks } from "./blocks"
import { stripDiffIndex } from "./diff"
import { pathHeading, pathUnheading, searchHeading, searchUnheading } from "./heading"
import { bytes } from "./lines"
import { collapseRuns, expandRuns } from "./runs"
import { DEFAULT_MAX_BLOCK_FOLD_BYTES, DEFAULT_MIN_BYTES } from "./types"
import type { LosslessConfig, LosslessResult, LosslessTransform } from "./types"

export function defaultConfig(): LosslessConfig {
  return {
    enabled: true,
    minBytes: DEFAULT_MIN_BYTES,
    maxBlockFoldBytes: DEFAULT_MAX_BLOCK_FOLD_BYTES,
  }
}

/** A reversible transform: forward and inverse; tryReversible checks the round trip */
type Reversible = {
  name: LosslessTransform
  forward: (text: string) => string
  inverse: (text: string) => string
}

const REVERSIBLE: Reversible[] = [
  // Order matters: adjacent runs first (cheap and common), repeated blocks last. Each step checks its round trip
  // against the result accepted so far, so stacking them is safe.
  { name: "runs", forward: collapseRuns, inverse: expandRuns },
  { name: "search-heading", forward: searchHeading, inverse: searchUnheading },
  { name: "path-heading", forward: pathHeading, inverse: pathUnheading },
  { name: "blocks", forward: foldRepeatedBlocks, inverse: unfoldRepeatedBlocks },
]

/**
 * Tries a reversible transform and accepts it only if it restores exactly and makes the text smaller.
 * Returns null when the transform is dropped; the caller continues from the same baseline.
 */
function tryReversible(baseline: string, transform: Reversible): string | null {
  const candidate = transform.forward(baseline)
  if (candidate === baseline) return null
  if (bytes(candidate) >= bytes(baseline)) return null
  if (transform.inverse(candidate) !== baseline) return null
  return candidate
}

export function compactLossless(text: string, config: LosslessConfig = defaultConfig()): LosslessResult | null {
  if (!config.enabled) return null
  const originalBytes = bytes(text)
  if (originalBytes < config.minBytes) return null

  try {
    const applied: LosslessTransform[] = []
    let current = text

    // Stripping ANSI is one-way: it only drops styling, so it is just checked to shrink the text. It must run first,
    // because later transforms check against the uncolored text and color codes would break line matching.
    const deansi = stripAnsi(current)
    if (deansi !== current && bytes(deansi) < bytes(current)) {
      current = deansi
      applied.push("ansi")
    }

    // Removing diff index lines is also one-way and only applies when the text is a diff
    const dediff = stripDiffIndex(current)
    if (dediff !== current && bytes(dediff) < bytes(current)) {
      current = dediff
      applied.push("diff-index")
    }

    for (const transform of REVERSIBLE) {
      if (transform.name === "blocks" && bytes(current) > config.maxBlockFoldBytes) continue
      const candidate = tryReversible(current, transform)
      if (!candidate) continue
      current = candidate
      applied.push(transform.name)
    }

    if (applied.length === 0) return null
    const compactedBytes = bytes(current)
    if (compactedBytes >= originalBytes) return null

    return { output: current, applied, originalBytes, compactedBytes }
  } catch {
    // Any failure means no compaction; it must never affect the tool result itself
    return null
  }
}

export { stripAnsi } from "./ansi"
export { foldRepeatedBlocks, unfoldRepeatedBlocks } from "./blocks"
export { stripDiffIndex } from "./diff"
export { pathHeading, pathUnheading, searchHeading, searchUnheading } from "./heading"
export { collapseRuns, expandRuns } from "./runs"
export { DEFAULT_MAX_BLOCK_FOLD_BYTES, DEFAULT_MIN_BYTES } from "./types"
export type { LosslessConfig, LosslessResult, LosslessTransform } from "./types"
export { getConfiguredLosslessConfig, getLosslessConfig } from "./config"
