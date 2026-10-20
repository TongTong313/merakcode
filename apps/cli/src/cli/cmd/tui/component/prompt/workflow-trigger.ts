import stringWidth from "string-width"

const QUOTE_CLOSE: Record<string, string> = {
  "'": "'",
  '"': '"',
  "`": "`",
  "(": ")",
  "[": "]",
  "{": "}",
  "<": ">",
}

export function findWorkflowTriggerPositions(text: string) {
  if (!/workflow/i.test(text)) return []
  if (text.startsWith("/")) return []

  const quoted: { start: number; end: number }[] = []
  let open: string | undefined
  let openAt = 0
  const isWord = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_]/u.test(ch)
  const isAsciiWord = (ch: string | undefined) => !!ch && /[a-zA-Z0-9_]/.test(ch)

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (!ch) continue
    if (open) {
      if (open === "[" && ch === "[") {
        openAt = i
        continue
      }
      if (ch !== QUOTE_CLOSE[open]) continue
      if (open === "'" && isWord(text[i + 1])) continue
      quoted.push({ start: openAt, end: i + 1 })
      open = undefined
      continue
    }
    if (
      (ch === "<" && i + 1 < text.length && /[a-zA-Z/]/.test(text[i + 1] ?? "")) ||
      (ch === "'" && !isWord(text[i - 1])) ||
      (ch !== "<" && ch !== "'" && ch in QUOTE_CLOSE)
    ) {
      open = ch
      openAt = i
    }
  }

  const result: { start: number; end: number }[] = []
  for (const match of text.matchAll(/workflow/gi)) {
    if (match.index === undefined) continue
    const start = match.index
    const end = start + match[0].length
    if (quoted.some((range) => start >= range.start && start < range.end)) continue
    const before = text[start - 1]
    const after = text[end]
    if (isAsciiWord(before) || isAsciiWord(after)) continue
    if (before === "/" || before === "\\" || before === "-") continue
    if (after === "/" || after === "\\" || after === "-" || after === "?") continue
    if (after === "." && isWord(text[end + 1])) continue
    result.push({ start, end })
  }
  return result
}

export function findWorkflowTriggerDisplayPositions(text: string) {
  return findWorkflowTriggerPositions(text).map((range) => ({
    start: stringWidth(text.slice(0, range.start)),
    end: stringWidth(text.slice(0, range.end)),
  }))
}
