// Pure logic of /assist/commit-message (no Hono, Provider, git or model), kept separate for unit tests.

import type { Text } from "../../../agent/prompt/text"
import { stripFences } from "./inline-edit-logic"

/**
 * Parses the output of `git log -n 5 --format=%B%x00` into the recent commit messages.
 * Messages are separated by NUL (%x00) rather than newlines, so multi-line bodies are not split.
 */
export function parseRecentCommits(logRaw: string): string[] {
  return logRaw
    .split("\0")
    .map((m) => m.trim())
    .filter((m) => m.length > 0)
}

/** Maximum untracked paths listed; the rest are summarized as "and N more" */
const UNTRACKED_PATH_SAMPLE = 20

function parsePathLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f.length > 0)
}

/** Lists up to `sample` untracked files; the rest are summarized as "and N more" */
function formatUntrackedSection(files: string[], sample = UNTRACKED_PATH_SAMPLE): string {
  if (files.length === 0) return ""
  const shown = files.slice(0, sample)
  const lines = shown.map((f) => "+ " + f)
  const rest = files.length - shown.length
  if (rest > 0) lines.push(`… and ${rest} more`)
  return "# New untracked files:\n" + lines.join("\n")
}

/** Formats small file content samples as extra context after the diff */
function formatSnippetSection(snippets: Array<{ path: string; content: string }>): string {
  if (snippets.length === 0) return ""
  const blocks = snippets.map((s) => `--- ${s.path} (snippet) ---\n${s.content}`)
  return "# File content samples:\n" + blocks.join("\n\n")
}

/** Untracked file content samples: max bytes read per file, max files, max characters per snippet */
export const SNIPPET_MAX_BYTES = 2048
export const SNIPPET_MAX_FILES = 3
export const SNIPPET_MAX_CHARS = 1000

const SNIPPET_SKIP = /(?:^|\/)(?:node_modules|\.git)(?:\/|$)|\.lock$|^nul$/i
const SNIPPET_BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|eot|pdf|zip|gz|exe|dll|so|dylib)$/i
const SNIPPET_PREFER = /\.(tsx?|jsx?|json|md|html|css|ya?ml|toml|xml|svg)$/i

/** Picks the untracked paths best suited for content samples (path rules only, no IO) */
export function selectSnippetPaths(paths: string[], max = SNIPPET_MAX_FILES): string[] {
  return paths
    .filter((p) => !SNIPPET_SKIP.test(p) && !SNIPPET_BINARY.test(p))
    .map((p, i) => ({ p, i, score: SNIPPET_PREFER.test(p) ? 2 : 1 }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, max)
    .map((x) => x.p)
}

/**
 * Formats an untracked file content sample: truncated to the character limit, optionally marked as the prefix of a
 * large file. Only for the input context; the model output is never truncated.
 */
export function formatSnippetContent(
  content: string,
  options?: { maxChars?: number; fileTruncated?: boolean },
): string {
  const max = options?.maxChars ?? SNIPPET_MAX_CHARS
  const trimmed = content.trim()
  const truncatedByChars = trimmed.length > max
  const body = truncatedByChars ? trimmed.slice(0, max) : trimmed
  if (!truncatedByChars && !options?.fileTruncated) return body
  // Byte and character truncation share one marker.
  if (options?.fileTruncated) return body + "\n…(file content truncated)"
  return body + "\n…(truncated)"
}

const CONVENTIONAL_TYPES = "feat|fix|docs|style|refactor|perf|test|build|ci|chore"
const RE_CONVENTIONAL_SCOPED = new RegExp(`^(${CONVENTIONAL_TYPES})\\([^)]+\\): `, "m")
const RE_CONVENTIONAL = new RegExp(`^(${CONVENTIONAL_TYPES}): `, "m")

function styleFamily(message: string): "conventional-scoped" | "conventional" | "freeform" {
  if (RE_CONVENTIONAL_SCOPED.test(message)) return "conventional-scoped"
  if (RE_CONVENTIONAL.test(message)) return "conventional"
  return "freeform"
}

function messageScore(message: string): number {
  let score = 0
  if (/\n-\s/.test(message)) score += 3
  if (/\n\n/.test(message)) score += 2
  if (RE_CONVENTIONAL.test(message) || RE_CONVENTIONAL_SCOPED.test(message)) score += 1
  return score
}

/**
 * Picks one or two recent commit messages that work best as one-shot style examples.
 * `recent` is in git log order: index 0 is the newest.
 */
export function pickStyleExamples(recent: string[]): string[] {
  const messages = recent.filter((m) => m.trim().length > 0)
  if (messages.length === 0) return []
  if (messages.length === 1) return [messages[0]]

  const families = new Set(messages.map(styleFamily))
  const best = (list: string[]) =>
    list.reduce((a, b, i, arr) => {
      const sa = messageScore(a)
      const sb = messageScore(b)
      if (sb > sa) return b
      if (sa > sb) return a
      // On a tie keep the newer one (earlier in the log).
      return arr.indexOf(a) < arr.indexOf(b) ? a : b
    })

  if (families.size === 1) return [best(messages)]

  const sorted = [...messages].sort((a, b) => {
    const d = messageScore(b) - messageScore(a)
    if (d !== 0) return d
    return messages.indexOf(a) - messages.indexOf(b)
  })
  const primary = sorted[0]
  const secondary = messages.find((m) => styleFamily(m) !== styleFamily(primary))
  return secondary ? [primary, secondary] : [primary]
}

export function parseNameStatus(raw: string): { added: number; modified: number; deleted: number } {
  let added = 0
  let modified = 0
  let deleted = 0
  for (const line of raw.trim().split("\n").filter(Boolean)) {
    const status = line.charAt(0)
    if (status === "A") added++
    else if (status === "D") deleted++
    else if (status === "M") modified++
    else if (status === "R" || status === "C") modified++
  }
  return { added, modified, deleted }
}

function fileExt(path: string): string {
  const i = path.lastIndexOf(".")
  return i >= 0 ? path.slice(i) : "(no ext)"
}

function topCounts(items: string[], limit = 5): string {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, n]) => `${k} (${n})`)
    .join(", ")
}

/** Summary lines of the change: file count, added/modified/deleted, most common extensions */
export function buildChangeSummary(input: {
  source: "staged" | "working"
  nameStatus?: string
  untracked: string
}): string {
  const untrackedFiles = parsePathLines(input.untracked)
  const ns = parseNameStatus(input.nameStatus ?? "")
  const untrackedCount = untrackedFiles.length
  const trackedTotal = ns.added + ns.modified + ns.deleted
  const total = input.source === "staged" ? trackedTotal : trackedTotal + untrackedCount

  const parts = [
    `${total} files: ${untrackedCount} added (untracked)`,
    `${ns.added} added (tracked)`,
    `${ns.modified} modified`,
    `${ns.deleted} deleted`,
  ]
  const lines = [parts.join(", ")]

  if (untrackedCount > 0) {
    const exts = topCounts(untrackedFiles.map(fileExt))
    if (exts) lines.push(`top extensions: ${exts}`)
  }

  return lines.join("\n")
}

export function composeWorkingTreeDiff(diff: string, untrackedRaw: string): string {
  // Tracked diff plus the untracked file list, since git diff leaves out untracked files.
  const files = parsePathLines(untrackedRaw)
  const parts: string[] = []
  if (diff.trim()) parts.push(diff)
  const untracked = formatUntrackedSection(files)
  if (untracked) parts.push(untracked)
  return parts.join("\n\n")
}

/** Input of buildChangeContext, filled in by the route after running git */
export type ChangeContextInput = {
  staged: string
  working: string
  untracked: string
  nameStatus?: string
  /** Content samples of small untracked files (path and snippet), read by the route */
  snippets?: Array<{ path: string; content: string }>
}

/** Structured change context for the prompt */
export type ChangeContext = {
  source: "staged" | "working"
  summary: string
  diff: string
  empty: boolean
}

/**
 * Builds the structured change context: staged changes if any, otherwise the working diff plus untracked files.
 */
export function buildChangeContext(input: ChangeContextInput): ChangeContext {
  if (input.staged.trim()) {
    const summary = buildChangeSummary({
      source: "staged",
      nameStatus: input.nameStatus,
      untracked: "",
    })
    return {
      source: "staged",
      summary,
      diff: input.staged.trim(),
      empty: false,
    }
  }

  const diff = composeWorkingTreeDiff(input.working, input.untracked)
  const snippet = formatSnippetSection(input.snippets ?? [])
  const full = [diff, snippet].filter((p) => p.trim()).join("\n\n")
  const summary = buildChangeSummary({
    source: "working",
    nameStatus: input.nameStatus,
    untracked: input.untracked,
  })
  return {
    source: "working",
    summary,
    diff: full,
    empty: !full.trim(),
  }
}

/**
 * Truncates a large diff to fit small model contexts. Beyond max, the head (file headers and first hunks) is kept
 * and a marker is appended.
 */
export function capDiff(diff: string, max = 8000): string {
  if (diff.length <= max) return diff
  return diff.slice(0, max) + "\n…(diff truncated)"
}

/**
 * Builds the commit message prompt: one-shot history examples plus the structured change context.
 * The prompt is in English; the message is written in the UI language (`lang`, from await Text.lang(); defaults to
 * Chinese).
 */
export function buildCommitMessagePrompt(input: {
  context: Pick<ChangeContext, "source" | "summary" | "diff">
  examples: string[]
  lang?: Text.Lang
}): { system: string; prompt: string } {
  const language = input.lang === "en" ? "English" : "Chinese"
  const system = [
    "You are a git commit message generator.",
    "",
    "[Style]",
    '- If "History examples" are provided, strictly mimic their prefix format, punctuation, blank lines and bullet style (one-shot).',
    "- If there are no examples or the style is unclear, use Conventional Commits in this format:",
    "  type: imperative summary",
    "  (blank line)",
    "  - detail points...",
    "  type is one of feat/fix/docs/style/refactor/perf/test/build/ci/chore; omit the scope when there is no clear module (write fix: / feat:, never fix(): or fix(unknown):).",
    "",
    "[Language]",
    `- Write the commit message in ${language}. Keep Conventional Commits type keywords (feat/fix/...) in English.`,
    "",
    "[Content]",
    "- Summarize the substantive changes in this diff accurately; do not invent files or operations that do not appear in it.",
    "- The added/modified/deleted counts in the change summary are the reliable source for the kind of each change.",
    '- Cover both the untracked file list and the "File content samples" in the message; if a large file is marked truncated, still describe its substance from the sampled prefix.',
    "- Related files can be combined into one item; avoid merely restating file names without saying what they do.",
    "",
    "[Structure and length]",
    "- The number of body items depends on the actual changes, not on the number of changed files.",
    "- Keep the subject line within 72 characters where possible; keep the whole message concise and complete, without filler.",
    "- Output only the commit message itself: no explanations, no markdown code blocks, no surrounding quotes.",
  ].join("\n")

  const examplesBlock =
    input.examples.length > 0
      ? input.examples.map((m, i) => `[Example ${i + 1}]\n${m}`).join("\n\n")
      : "(No history examples; fall back to Conventional Commits)"

  const prompt = [
    "## Change source",
    input.context.source,
    "",
    "## Change summary",
    input.context.summary || "(no summary)",
    "",
    "## Change details",
    `<diff>\n${input.context.diff}\n</diff>`,
    "",
    "## History examples (mimic this style)",
    examplesBlock,
    "",
    `Write the commit message for this change in ${language}:`,
  ].join("\n")

  return { system, prompt }
}

/**
 * Cleans the model output into a commit message ready for the commit box: strip fences, drop the explanation prefix
 * small models like to add, remove surrounding quotes or backticks, trim, and collapse extra blank lines.
 */
export function cleanCommitMessage(raw: string): string {
  let text = stripFences(raw).trim()
  // Explanation prefixes in English or Chinese, possibly followed by a newline.
  text = text.replace(/^(?:here(?:'s| is)[^\n:]*:|commit message:|提交信息[:：])\s*/i, "").trim()
  // Only when the first and last characters are the same quote.
  const quote = text[0]
  if ((quote === '"' || quote === "'" || quote === "`") && text.endsWith(quote) && text.length >= 2) {
    text = text.slice(1, -1).trim()
  }
  // Keep paragraph breaks but collapse runs of blank lines into one.
  text = text.replace(/\n{3,}/g, "\n\n")
  return text.trim()
}
