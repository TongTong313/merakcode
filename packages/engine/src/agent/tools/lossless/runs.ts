/**
 * Folds adjacent repeated lines, syslog style.
 *
 * N identical consecutive lines (N >= 2) become the line followed by "... (repeated N times)". The count is in the
 * marker, so expandRuns restores the text exactly.
 *
 * If the input already contains a line like "... (repeated 3 times)", restoring is ambiguous. Escaping would make the
 * output harder to read, so instead the round-trip check in compactLossless drops the transform when it cannot
 * restore the input exactly.
 */

import { join, split } from "./lines"

const MARKER_RE = /^\.\.\. \(repeated (\d+) times\)$/

export function collapseRuns(text: string) {
  const { lines, trailing } = split(text)
  if (lines.length === 0) return text

  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    let end = i
    while (end + 1 < lines.length && lines[end + 1] === lines[i]) end++
    const runLength = end - i + 1
    out.push(lines[i])
    // Only repeated lines get a marker; marking single lines would make the output larger
    if (runLength >= 2) out.push(`... (repeated ${runLength} times)`)
    i = end + 1
  }
  return join(out, trailing)
}

export function expandRuns(text: string) {
  const { lines, trailing } = split(text)
  if (lines.length === 0) return text

  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const marker = i + 1 < lines.length ? MARKER_RE.exec(lines[i + 1]) : null
    if (marker) {
      const count = Number(marker[1])
      for (let n = 0; n < count; n++) out.push(line)
      i += 2
      continue
    }
    out.push(line)
    i++
  }
  return join(out, trailing)
}
