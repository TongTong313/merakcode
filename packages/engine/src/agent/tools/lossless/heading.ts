/**
 * Folds repeated path prefixes into heading lines, like ripgrep --heading.
 *
 * Two independent forms:
 * - searchHeading: grep `path:line:content` rows become the path once, followed by `line:content` rows
 * - pathHeading: plain path lists (find / ls -1 / rg -l) become the parent directory once, followed by basenames
 *
 * Neither inserts blank separator lines: a blank line cannot be told apart from passed-through content, which would
 * break reversibility.
 */

import { join, split } from "./lines"

// Default grep row `path:line:content`. The path must not start with a bare number, otherwise a `line:content` row
// that is already in heading form would be split again.
const GREP_ROW_RE = /^(?<path>[^\n:]+):(?<line>\d+):(?<content>.*)$/
// Data row in heading form: `line:content`
const HEADING_ROW_RE = /^(?<line>\d+):(?<content>.*)$/

export function searchHeading(text: string) {
  const { lines, trailing } = split(text)
  if (lines.length === 0) return text

  const out: string[] = []
  let currentPath: string | null = null
  for (const line of lines) {
    const row = GREP_ROW_RE.exec(line)
    if (row?.groups) {
      const { path, line: lineNo, content } = row.groups
      if (path !== currentPath) {
        out.push(path)
        currentPath = path
      }
      out.push(`${lineNo}:${content}`)
      continue
    }
    // Any non-grep line ends the current group so separate sections are not merged
    out.push(line)
    currentPath = null
  }
  return join(out, trailing)
}

export function searchUnheading(text: string) {
  const { lines, trailing } = split(text)
  if (lines.length === 0) return text

  const out: string[] = []
  let currentPath: string | null = null
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const data = HEADING_ROW_RE.exec(line)
    if (currentPath !== null && data?.groups) {
      out.push(`${currentPath}:${data.groups.line}:${data.groups.content}`)
      i++
      continue
    }
    // A new heading line is not a data row itself and is followed by one
    if (!data && i + 1 < lines.length && HEADING_ROW_RE.test(lines[i + 1])) {
      currentPath = line
      i++
      continue
    }
    currentPath = null
    out.push(line)
    i++
  }
  return join(out, trailing)
}

// A whole line that is a file path: at least one directory segment plus a basename, with no whitespace or colons.
// Lines with colons are left to searchHeading; bare directory lines have no basename and never match, which keeps
// folding unambiguous.
const PATH_ROW_RE = /^(?<dir>(?:\.{0,2}\/)?(?:[^/\s:]+\/)+)(?<base>[^/\s:]+)$/

export function pathHeading(text: string) {
  const { lines, trailing } = split(text)
  let rows = 0
  for (const line of lines) if (PATH_ROW_RE.test(line)) rows++
  // With fewer than two path rows there is no common prefix to fold
  if (rows < 2) return text

  const out: string[] = []
  let currentDir: string | null = null
  for (const line of lines) {
    const row = PATH_ROW_RE.exec(line)
    if (row?.groups) {
      const { dir, base } = row.groups
      if (dir !== currentDir) {
        out.push(dir)
        currentDir = dir
      }
      out.push(base)
      continue
    }
    out.push(line)
    currentDir = null
  }
  return join(out, trailing)
}

export function pathUnheading(text: string) {
  const { lines, trailing } = split(text)
  if (lines.length === 0) return text

  const out: string[] = []
  let currentDir: string | null = null
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const isBase = line !== "" && !line.includes("/")
    if (currentDir !== null && isBase) {
      out.push(currentDir + line)
      i++
      continue
    }
    // A heading line ends with / and is followed by a basename line
    const next = i + 1 < lines.length ? lines[i + 1] : undefined
    if (line.endsWith("/") && next !== undefined && next !== "" && !next.includes("/")) {
      currentDir = line
      i++
      continue
    }
    currentDir = null
    out.push(line)
    i++
  }
  return join(out, trailing)
}
