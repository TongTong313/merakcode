/**
 * Shared types of the lossless compaction layer.
 *
 * Differences from bash-output-compaction (lossy summaries):
 * - Every transform here has an exact inverse and is round-trip checked right away; it is dropped if it cannot
 *   restore the input
 * - Transforms only take a string, not command/cwd/exitCode, so they can be reused for other tool output
 */

/** Name of a lossless transform, listed in the compaction header to show which folds were applied */
export type LosslessTransform = "ansi" | "runs" | "blocks" | "search-heading" | "path-heading" | "diff-index"

export type LosslessConfig = {
  enabled: boolean
  /** Output smaller than this many bytes is left alone */
  minBytes: number
  /** Output larger than this many bytes skips block folding, whose scan is O(n × candidates) */
  maxBlockFoldBytes: number
}

export const DEFAULT_MIN_BYTES = 500
/** Block folding is skipped above 1 MB: the scan is O(lines × candidates) and not worth it for huge input */
export const DEFAULT_MAX_BLOCK_FOLD_BYTES = 1024 * 1024

export type LosslessResult = {
  output: string
  /** Transforms that took effect, in order; ones that failed the round-trip check or did not shrink are absent */
  applied: LosslessTransform[]
  originalBytes: number
  compactedBytes: number
}
