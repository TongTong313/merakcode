/**
 * Lenient parsing of structured output from small models.
 *
 * Small models often ignore "output JSON only": they add explanations, wrap it in a ```json block or stop halfway.
 * Two fallbacks: extract the first **brace-balanced** JSON object from free text, then read an integer array by field
 * name. Failures return undefined so the caller can fall back; nothing throws into the main flow.
 */

/**
 * Extracts the first brace-balanced `{...}` substring from free text, skipping braces and escapes inside string
 * literals. Returns null if there is none.
 */
export function extractBalancedJsonObject(text: string): string | null {
  const start = text.indexOf("{")
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (inString) {
      if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "{") depth++
    else if (char === "}") {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/**
 * Parses an index array of the form `{"<field>":[0,2,5]}` from model output.
 *
 * Tries JSON.parse on the whole text first, then the brace-balanced extraction. Elements may be numbers or numeric
 * strings; out-of-range (>= count) and non-integer values are dropped and duplicates removed. Returns undefined if
 * every attempt fails.
 *
 * @param count upper bound for indexes (number of candidates), filtering out indexes the model made up
 */
export function parseIndexArray(text: string, field: string, count: number): number[] | undefined {
  for (const candidate of [text, extractBalancedJsonObject(text)]) {
    if (!candidate) continue
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>
      const raw = parsed?.[field]
      if (!Array.isArray(raw)) continue
      const ids = raw
        .map((item) => (typeof item === "number" ? item : Number.parseInt(String(item), 10)))
        .filter((n) => Number.isInteger(n) && n >= 0 && n < count)
      return Array.from(new Set(ids))
    } catch {
      // Try the next candidate
    }
  }
  return undefined
}
