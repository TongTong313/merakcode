import { Config } from "@merakcode/engine/agent/settings/index"
import {
  cjkGrams,
  hasCjk,
  MIN_QUERY_LENGTH,
  normalize,
  splitScriptRuns,
  termScore,
  tokenize,
} from "../../infra/match/text-rank"
import type { DeferredToolSummary } from "./tool-search"

/**
 * Matches the user query against deferred tools to decide which to activate (Stage A: deterministic scoring).
 *
 * Deferred tools are only listed by name in the tool_search description, and models often fail to activate them on
 * their own: asked to "use workflow" for some research, a model read it as "work step by step", used todowrite and
 * webfetch, and never called tool_search, so workflow_run stayed inactive. Matches are graded by strength:
 * - STRONG: a query term equals a segment of the tool id or a triggerHint entry. The tool is activated at once and
 *   has its full schema this turn, without relying on the model.
 * - WEAK: only prefix or substring hits. Left to Stage B (small-model selection, see tool-discovery-rerank), which
 *   is off by default; with few candidates deterministic scoring is enough.
 * - No match: nothing changes.
 *
 * Weights: id segments highest, then triggerHint, then the full description. triggerHint only feeds the scorer and
 * never appears in a prompt; showing it to the model brings no benefit, but it works as a search signal.
 */
export namespace ToolDiscovery {
  /**
   * Words ignored in scoring. Besides function words, this drops common Chinese imperative phrases ("help me",
   * "for a moment"), which cjkGrams would otherwise turn into bigrams that produce noise hits.
   */
  const STOP_WORDS = new Set([
    // English function words
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "can",
    "do",
    "for",
    "from",
    "help",
    "how",
    "if",
    "in",
    "is",
    "it",
    "me",
    "my",
    "of",
    "on",
    "or",
    "please",
    "the",
    "then",
    "this",
    "to",
    "tool",
    "tools",
    "use",
    "using",
    "want",
    "what",
    "with",
    "you",
    "your",
    // Common Chinese imperative and pronoun bigrams
    "一下",
    "一个",
    "一些",
    "下面",
    "什么",
    "使用",
    "关于",
    "可以",
    "如何",
    "帮忙",
    "帮我",
    "怎么",
    "我们",
    "我用",
    "所有",
    "接下",
    "现在",
    "用的",
    "的时",
    "看看",
    "这个",
    "这些",
    "那个",
    "需要",
    "然后",
    "请你",
    "工具",
  ])

  /**
   * Generic programming words in tool ids. They add to the score but never trigger automatic activation.
   *
   * Many id segments are everyday coding words (parse in `excel_parse`, get/file in `figma_get_file`) that appear in
   * coding queries as file names, function names and plain verbs, not as requests for the tool. "add a test for
   * classifyPage in pdf-parse.ts" hit excel_parse via "parse", and "get the pod logs" hit figma_get_file via "get",
   * each wasting a full schema. Only discriminative segments (excel, pdf, notion, k8s...) count.
   */
  const GENERIC_ID_PARTS = new Set([
    "add",
    "api",
    "call",
    "create",
    "data",
    "delete",
    "detail",
    "exec",
    "execute",
    "fetch",
    "file",
    "files",
    "find",
    "get",
    "info",
    "item",
    "items",
    "list",
    "load",
    "make",
    "new",
    "open",
    "page",
    "pages",
    "parse",
    "put",
    "query",
    "read",
    "remove",
    "run",
    "save",
    "search",
    "send",
    "set",
    "show",
    "start",
    "stop",
    "text",
    "tool",
    "update",
    "write",
  ])

  /** Most tools activated automatically per turn ("excel" matches both parse and write). */
  export const AUTO_ACTIVATE_LIMIT = 2

  /**
   * Share of the top score the second strong match needs to be activated as well.
   *
   * - Close scores (an xlsx request matching both excel_parse and excel_write): read or write intent is unclear, so
   *   activating both is safer.
   * - Far apart ("search notion pages" scores notion_search_pages well above notion_create_page): the second one only
   *   rode along and would be wasted.
   */
  const SECONDARY_SCORE_RATIO = 0.8

  /** Most candidates returned by rank, also used by Stage B. */
  export const RANK_LIMIT = 15

  /**
   * Most query characters that are scored.
   *
   * CJK text has no spaces, so its terms come from n-grams, about three per character: 2000 distinct Chinese
   * characters give about 6000 terms, and ranking 50 MCP candidates then takes ~125ms. Users often paste long logs or
   * documents, and this runs before every LLM call.
   *
   * Both the head and the tail are kept because the intent may come before the pasted text or after it.
   */
  export const MAX_QUERY_CHARS = 1000

  /** Keeps the head and tail of a long query; the middle is usually pasted content without intent. */
  function clampQuery(query: string) {
    if (query.length <= MAX_QUERY_CHARS) return query
    const half = MAX_QUERY_CHARS / 2
    return `${query.slice(0, half)}\n${query.slice(-half)}`
  }

  /** Code blocks and inline code in backticks */
  const CODE_SPAN = /```[\s\S]*?```|`[^`]*`/g
  /** File names with a source extension (`excel-parse.ts`, `main.py`...) */
  const SOURCE_FILE =
    /[\w.\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|java|rb|rs|c|h|cc|cpp|cs|php|swift|kt|scala|sh|sql|json|jsonc|ya?ml|toml|lock|md)\b/gi
  /**
   * ASCII paths (`packages/engine/src/agent/tools`). Both sides of the slash must be ASCII word characters so Chinese
   * alternatives written with a slash ("read/write") are left alone.
   */
  const PATH_LIKE = /[A-Za-z0-9_.\-*]+(?:[/\\][A-Za-z0-9_.\-*]+)+/g

  /**
   * Removes code entities from the query before extracting terms. A user who mentions `excel-parse.ts` is discussing
   * code, not asking for excel_parse, yet the file name splits into the tool's id segments and would trigger automatic
   * activation. This is common in this repository, where the tools' own sources get edited.
   */
  function stripCodeEntities(query: string) {
    return query.replace(CODE_SPAN, " ").replace(PATH_LIKE, " ").replace(SOURCE_FILE, " ")
  }

  export type Match = {
    tool: DeferredToolSummary
    score: number
    /**
     * Whether a query term equals a discriminative id segment or a triggerHint entry. Only this triggers automatic
     * activation; the total score of a long query can be pushed up by many weak hits.
     */
    strong: boolean
  }

  /**
   * Splits a tool id into searchable segments. MCP ids (`${server}_${tool}`, built by MCP.tools() with invalid
   * characters replaced by `_`) look like built-in snake_case ids, so splitting on `_`, `-` and camelCase covers both.
   */
  export function parseToolId(id: string) {
    const spaced = id.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    const parts = tokenize(spaced)
    return {
      parts,
      full: parts.join(" "),
      // The only id evidence for automatic activation. May be empty when the id has only generic words; then only
      // triggerHint can activate the tool automatically.
      discriminative: parts.filter((part) => !GENERIC_ID_PARTS.has(part)),
    }
  }

  /**
   * Terms of the query used for scoring. Unlike SkillSearch.termsForRank, the query is first split at script
   * boundaries with {@link splitScriptRuns}: Chinese text has no spaces, so an English word written inside a Chinese
   * sentence would otherwise be part of one long token, and "workflow" would never match workflow_run.
   */
  export function queryTerms(query: string) {
    // Clamp first so the regexes get bounded input, then strip code entities.
    const clamped = stripCodeEntities(clampQuery(query))
    const terms = splitScriptRuns(clamped)
      .flatMap((run) => tokenize(run))
      .filter((term) => hasCjk(term) || term.length >= MIN_QUERY_LENGTH)
      .filter((term) => !STOP_WORDS.has(term))
    // CJK n-grams: without spaces, only grams can match Chinese hint entries.
    const grams = cjkGrams(clamped).filter((gram) => !STOP_WORDS.has(gram))
    return Array.from(new Set([...terms, ...grams]))
  }

  function scoreTool(tool: DeferredToolSummary, terms: string[]): Match {
    const id = parseToolId(tool.id)
    const hintTokens = tool.triggerHint ? tokenize(tool.triggerHint) : []
    const hintHay = tool.triggerHint ? normalize(tool.triggerHint) : ""
    const textHay = tool.searchText ? normalize(tool.searchText) : ""
    // tokenize, not a whitespace split: normalize keeps `_` and `-`, so "search_pages", common in MCP descriptions,
    // would stay one token and "search" would never match exactly.
    const textTokens = tool.searchText ? tokenize(tool.searchText) : []

    let score = 0
    let strong = false
    for (const term of terms) {
      // id segments are the strongest signal ("workflow" is a segment of workflow_run).
      score += termScore({ term, tokens: id.parts, haystack: id.full, exact: 10, prefix: 7, partial: 5 })
      // triggerHint: hand-written cross-language aliases, second to the id.
      if (hintTokens.length) {
        score += termScore({ term, tokens: hintTokens, haystack: hintHay, exact: 8, prefix: 5, partial: 3 })
      }
      // Full description: a weak signal, mainly for MCP tools without triggerHint.
      if (textTokens.length) {
        score += termScore({ term, tokens: textTokens, haystack: textHay, exact: 3, prefix: 2, partial: 1 })
      }
      // Generic id segments (parse/get/write...) still score but cannot make a match strong.
      if (id.discriminative.includes(term) || hintTokens.includes(term)) strong = true
    }
    return { tool, score, strong }
  }

  /**
   * Ranks deferred tools by relevance to the query. Strong matches come first, then by score, then by id so the order
   * is stable and the prompt does not change between turns.
   */
  export function rank(input: { candidates: readonly DeferredToolSummary[]; query: string; limit?: number }): Match[] {
    const terms = queryTerms(input.query)
    if (terms.length === 0) return []
    return input.candidates
      .map((tool) => scoreTool(tool, terms))
      .filter((match) => match.score > 0)
      .sort((a, b) => Number(b.strong) - Number(a.strong) || b.score - a.score || a.tool.id.localeCompare(b.tool.id))
      .slice(0, input.limit ?? RANK_LIMIT)
  }

  /** Ids to activate automatically: strong matches only, at most {@link AUTO_ACTIVATE_LIMIT}. */
  export function autoActivateIds(matches: readonly Match[]) {
    const strong = matches.filter((match) => match.strong)
    if (strong.length === 0) return []
    // The top match always qualifies; the rest must clear the threshold so tools that only rode along stay deferred.
    const threshold = strong[0]!.score * SECONDARY_SCORE_RATIO
    return strong
      .filter((match, index) => index === 0 || match.score >= threshold)
      .slice(0, AUTO_ACTIVATE_LIMIT)
      .map((match) => match.tool.id)
  }

  /**
   * Server of an MCP tool id (`${sanitizedServer}_${tool}`). Server names get the same character replacement as in
   * MCP.tools() ([^a-zA-Z0-9_-] to `_`), and the longest prefix wins when one server name is a prefix of another.
   */
  export function serverNameOf(id: string, serverNames: readonly string[]): string | undefined {
    let best: string | undefined
    for (const name of serverNames) {
      const prefix = name.replace(/[^a-zA-Z0-9_-]/g, "_")
      if (prefix && id.startsWith(prefix + "_") && (!best || name.length > best.length)) best = name
    }
    return best
  }

  /**
   * When a strong match belongs to an MCP server, activates all of that server's pending tools instead of only
   * {@link AUTO_ACTIVATE_LIMIT}.
   *
   * With a knowledge base server of 16 kb_* tools, asking to view the knowledge base activated only two write tools,
   * and the model concluded the server could not query and switched to built-in tools. MCP servers are added as a
   * whole, and the model can only choose between their query, write and admin tools when it sees all of them.
   *
   * Only servers with a hit are expanded, so other servers do not bloat the context.
   */
  export function expandMcpServerActivation(input: {
    selected: readonly string[]
    candidates: readonly DeferredToolSummary[]
    mcpIds: ReadonlySet<string>
    serverNames: readonly string[]
  }): string[] {
    const { selected, candidates, mcpIds, serverNames } = input
    if (selected.length === 0 || serverNames.length === 0) return [...selected]

    const hitServers = new Set<string>()
    for (const id of selected) {
      if (!mcpIds.has(id)) continue
      const server = serverNameOf(id, serverNames)
      if (server) hitServers.add(server)
    }
    if (hitServers.size === 0) return [...selected]

    // Keep the selected order and append the expansion.
    const out = [...selected]
    for (const tool of candidates) {
      if (out.includes(tool.id) || !mcpIds.has(tool.id)) continue
      const server = serverNameOf(tool.id, serverNames)
      if (server && hitServers.has(server)) out.push(tool.id)
    }
    return out
  }

  /** Automatic activation on strong matches, on by default; false leaves activation to the model via tool_search. */
  export async function autoActivateEnabled() {
    const cfg = await Config.get()
    return cfg.tool_discovery?.auto_activate !== false
  }

  /** Stage B small-model selection, off by default (not worth it with few candidates, see tool-discovery-rerank). */
  export async function rerankEnabled() {
    const cfg = await Config.get()
    return cfg.tool_discovery?.rerank === "auto"
  }
}
