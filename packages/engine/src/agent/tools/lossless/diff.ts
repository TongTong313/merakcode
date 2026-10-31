/**
 * Removes the `index <sha>..<sha> <mode>` bookkeeping lines from unified diffs.
 *
 * git only uses these lines for rename and blob bookkeeping; the diff still applies without them and the model loses
 * nothing. There is no inverse, so the text must actually be a diff (contain `diff --git` or `@@`) before anything is
 * removed, to avoid deleting a similar-looking line from an ordinary file.
 */

import { join, split } from "./lines"

const INDEX_RE = /^index [0-9a-fA-F]+\.\.[0-9a-fA-F]+( [0-7]+)?$/
const DIFF_MARKER_RE = /^(?:diff --git |@@ )/m

export function stripDiffIndex(text: string) {
  if (!DIFF_MARKER_RE.test(text)) return text
  const { lines, trailing } = split(text)
  if (lines.length === 0) return text
  const out = lines.filter((line) => !INDEX_RE.test(line))
  if (out.length === lines.length) return text
  return join(out, trailing)
}
