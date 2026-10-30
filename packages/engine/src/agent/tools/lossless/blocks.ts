/**
 * Repeated block folding, the multi-line version of collapseRuns.
 *
 * K consecutive lines (K >= 3) identical to K lines that appeared D lines earlier are folded into
 * "... (repeats K lines from D lines back)". Unlike runs, the repeats need not be adjacent, which matches config
 * files and structured output (similar stanzas that differ only in the name line).
 *
 * Reversibility depends on two constraints: positions are line numbers in the original text, and a block is only
 * folded when it does not overlap its anchor (K <= D), so the referenced lines are always rebuilt before expansion.
 */

import { join, split } from "./lines"

const MARKER_RE = /^\.\.\. \(repeats (\d+) lines from (\d+) lines back\)$/

const MIN_BLOCK = 3
const MAX_BLOCK = 64
/** Earlier positions remembered per distinct line, so common lines such as "  }" do not blow up the scan */
const MAX_CANDIDATES = 8

function remember(positions: Map<string, number[]>, line: string, index: number) {
  let bucket = positions.get(line)
  if (!bucket) {
    bucket = []
    positions.set(line, bucket)
  }
  bucket.push(index)
  if (bucket.length > MAX_CANDIDATES) bucket.shift()
}

export function foldRepeatedBlocks(text: string) {
  const { lines, trailing } = split(text)
  if (lines.length < MIN_BLOCK * 2) return text

  const positions = new Map<string, number[]>()
  const out: string[] = []
  let i = 0

  while (i < lines.length) {
    let bestLength = 0
    let bestDistance = 0

    // Search from the nearest candidate back: a closer anchor has a shorter marker and more likely starts a long block
    const candidates = positions.get(lines[i]) ?? []
    for (let c = candidates.length - 1; c >= 0; c--) {
      const anchor = candidates[c]
      // Capping at i - anchor keeps K <= D (no overlap with the anchor), which reversibility requires
      const maxLength = Math.min(MAX_BLOCK, lines.length - i, i - anchor)
      let length = 0
      while (length < maxLength && lines[anchor + length] === lines[i + length]) length++
      if (length > bestLength) {
        bestLength = length
        bestDistance = i - anchor
      }
    }

    if (bestLength >= MIN_BLOCK) {
      const marker = `... (repeats ${bestLength} lines from ${bestDistance} lines back)`
      let blockChars = 0
      for (let k = 0; k < bestLength; k++) blockChars += lines[i + k].length + 1
      // The marker costs bytes too; fold only when the result is shorter
      if (blockChars > marker.length + 1) {
        out.push(marker)
        // Folded lines still record their original positions so later blocks can reference them
        for (let k = 0; k < bestLength; k++) remember(positions, lines[i + k], i + k)
        i += bestLength
        continue
      }
    }

    remember(positions, lines[i], i)
    out.push(lines[i])
    i++
  }

  return join(out, trailing)
}

export function unfoldRepeatedBlocks(text: string) {
  const { lines, trailing } = split(text)
  if (lines.length === 0) return text

  const out: string[] = []
  for (const line of lines) {
    const marker = MARKER_RE.exec(line)
    if (marker) {
      const length = Number(marker[1])
      const distance = Number(marker[2])
      const start = out.length - distance
      // Same constraints as when folding: out of range or overlapping markers stay as plain lines and the round-trip
      // check rejects the fold
      if (start >= 0 && length <= distance) {
        for (let k = 0; k < length; k++) out.push(out[start + k])
        continue
      }
    }
    out.push(line)
  }
  return join(out, trailing)
}
