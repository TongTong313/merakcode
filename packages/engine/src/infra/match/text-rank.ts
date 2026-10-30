/**
 * Shared primitives for text search scoring: tokenizing, normalizing, CJK n-grams and term scores.
 *
 * Used by memory/recall.ts and skill/search.ts. Each caller passes its own STOP_WORDS because they differ: recall
 * drops words like memory/recall, skill search drops words like skill/task.
 */

/** Minimum term length (CJK terms are exempt, see {@link termsForRank}) */
export const MIN_QUERY_LENGTH = 2

/** Token separators: whitespace and the punctuation `:` / `/` / `_` / `-` */
export const TOKEN_SPLIT = /[\s:/_-]+/g

/** Lowercases text and collapses non-alphanumeric runs into single spaces for literal matching */
export function normalize(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function tokenize(value: string) {
  return normalize(value).split(TOKEN_SPLIT).filter(Boolean)
}

/** Whether the text contains CJK characters (CJK Extension A and Unified Ideographs) */
export function hasCjk(value: string) {
  return /[㐀-鿿]/u.test(value)
}

/**
 * Splits CJK runs into 2/3/4-grams (character sliding window, joined without separators); a single-character run is
 * kept as is. Makes up for CJK text having no spaces to split words on.
 */
export function cjkGrams(value: string) {
  const grams: string[] = []
  for (const match of value.matchAll(/[㐀-鿿]+/gu)) {
    const chars = Array.from(match[0])
    if (chars.length === 1) {
      grams.push(chars[0])
      continue
    }
    for (const size of [2, 3, 4]) {
      if (chars.length < size) continue
      for (let index = 0; index <= chars.length - size; index++) {
        grams.push(chars.slice(index, index + size).join(""))
      }
    }
  }
  return grams
}

/**
 * Splits text at script boundaries: CJK runs and non-CJK runs separate each other.
 *
 * Chinese users often embed English identifiers in unspaced Chinese text (CJK, then "workflow", then more CJK).
 * Splitting only on whitespace and punctuation keeps the whole sentence as one token, so "workflow" never matches
 * workflow_run. This splits such text into [CJK run, "workflow", CJK run] before {@link tokenize}.
 *
 * It does not change the existing tokenizing, so memory/recall and skill/search scores are unaffected.
 */
export function splitScriptRuns(value: string) {
  return value.match(/[㐀-鿿]+|[^㐀-鿿]+/gu) ?? []
}

/**
 * Scores one term against a haystack (exact > prefix > partial).
 * - exact: the term equals one of the tokens
 * - prefix: the term and a token are prefixes of each other (either way, for light fuzziness)
 * - partial: the haystack contains the term as a substring
 */
export function termScore(input: {
  term: string
  tokens: string[]
  haystack: string
  exact: number
  prefix: number
  partial: number
}) {
  if (input.tokens.includes(input.term)) return input.exact
  if (input.tokens.some((token) => token.startsWith(input.term) || input.term.startsWith(token))) {
    return input.prefix
  }
  if (input.haystack.includes(input.term)) return input.partial
  return 0
}

/**
 * Whether there are enough secondary matches (weak fields such as descriptions) to keep a candidate with no primary
 * match, so a single weak match does not cause noisy results.
 */
export function hasEnoughSecondaryMatches(terms: string[], matches: number) {
  if (matches === 0) return false
  if (terms.some(hasCjk)) return matches >= 1
  if (terms.length === 1) return matches >= 1 && terms[0].length >= 5
  return matches >= Math.min(2, terms.length)
}

/**
 * Builds the deduplicated set of terms to score: drops stop words and too-short terms (except CJK), then adds CJK
 * n-grams.
 * @param query raw query
 * @param stopWords stop words, chosen by the caller for its use case
 */
export function termsForRank(query: string, stopWords: Set<string>) {
  const terms = tokenize(query)
    .filter((term) => term.length >= MIN_QUERY_LENGTH || hasCjk(term))
    .filter((term) => !stopWords.has(term))
  return Array.from(new Set([...terms, ...cjkGrams(query)]))
}
