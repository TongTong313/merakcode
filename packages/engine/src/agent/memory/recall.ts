import path from "path"
import { Config } from "@merakcode/engine/agent/settings/index"
import { Identifier } from "@merakcode/util/id"
import { Instance } from "../../infra/project/instance"
import {
  hasEnoughSecondaryMatches,
  normalize,
  termScore,
  termsForRank as textRankTermsForRank,
  tokenize,
} from "../../infra/match/text-rank"
import { Message } from "../session/message"
import { MemoryPath } from "./path"
import { MemoryRerank } from "./rerank"
import { MemoryScan } from "./scan"
import { resolveExtractPolicy } from "./util"
import { Filesystem } from "@merakcode/util/filesystem"

export namespace MemoryRecall {
  export const METADATA_KIND = "relevant_memories"
  export const MAX_SELECTED = 5
  export const MAX_MEMORY_LINES = 200
  export const MAX_MEMORY_BYTES = 4096
  export const MAX_SESSION_BYTES = 60 * 1024

  const IGNORE_MEMORY_CJK = new RegExp(
    [
      "(?:\\u4e0d\\u8981|\\u522b|\\u4e0d|\\u52ff)",
      "(?:\\u4f7f\\u7528|\\u8bfb\\u53d6|\\u68c0\\u7d22|\\u52a0\\u8f7d)?\\u8bb0\\u5fc6",
      "\\u5ffd\\u7565\\u8bb0\\u5fc6",
      "\\u4e0d\\u8981\\u7528\\u8bb0\\u5fc6",
    ].join("|"),
    "u",
  )
  const EXPLICIT_RECALL_CJK = new RegExp(
    ["\\u8bb0\\u5fc6", "\\u8bb0\\u4f4f", "\\u56de\\u5fc6", "\\u4e4b\\u524d", "\\u4ee5\\u524d"].join("|"),
    "u",
  )
  const EXTERNAL_REFERENCE_HINT = new RegExp(
    [
      "https?://",
      "\\b[a-z0-9.-]+\\.[a-z]{2,}(?:/|\\b)",
      "\\b(linear|jira|slack|grafana|dashboard|dashboards|ticket|tickets|issue|issues|tracker|channel|channels|oncall|pagerduty|sentry|datadog|notion|confluence)\\b",
      "\\b[A-Z][A-Z0-9]+-\\d+\\b",
      "(?:\\u5916\\u90e8|\\u7cfb\\u7edf|\\u94fe\\u63a5|\\u94fe\\u8def|\\u770b\\u677f|\\u4eea\\u8868\\u76d8|\\u5de5\\u5355|\\u5de5\\u5355\\u7cfb\\u7edf|\\u9891\\u9053|\\u7fa4\\u7ec4|\\u76d1\\u63a7|\\u544a\\u8b66|\\u4e8b\\u6545)",
    ].join("|"),
    "iu",
  )
  const INTERNAL_REFERENCE_NOISE = new RegExp(
    [
      "\\b(plan|plans|task|tasks|checklist|doc|docs|documentation|readme|architecture|guide|guides|merge|summary|summaries|test|tests|implementation|repo|repository|file|files|path|paths)\\b",
      "(?:\\u8ba1\\u5212|\\u4efb\\u52a1|\\u6587\\u6863|\\u67b6\\u6784|\\u6307\\u5357|\\u8bf4\\u660e|\\u6d4b\\u8bd5|\\u5408\\u5e76|\\u603b\\u7ed3|\\u6458\\u8981|\\u5b9e\\u73b0|\\u4ee3\\u7801|\\u6587\\u4ef6|\\u8def\\u5f84)",
    ].join("|"),
    "iu",
  )
  const STOP_WORDS = new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "but",
    "by",
    "can",
    "current",
    "do",
    "does",
    "file",
    "files",
    "for",
    "from",
    "help",
    "here",
    "how",
    "if",
    "in",
    "into",
    "is",
    "it",
    "me",
    "memory",
    "memories",
    "need",
    "now",
    "of",
    "on",
    "or",
    "please",
    "recall",
    "remember",
    "that",
    "the",
    "this",
    "to",
    "use",
    "using",
    "want",
    "with",
    "you",
  ])

  export type Memory = {
    path: string
    content: string
    mtimeMs: number
    header: string
  }

  export type Attachment = {
    query: string
    text: string
    memories: Memory[]
    paths: string[]
    bytes: number
  }

  export async function part(input: {
    messages: Message.FullMsg[]
    user: Message.UserInfo
    limit?: number
    memoryDir?: string
    /**
     * Prefetch started by the caller (runner) at the start of the turn. When given it is awaited and reused, so
     * building the context view does not block on it; otherwise the attachment is computed inline (for direct
     * callers and unit tests). The promise must already handle errors; resolving to undefined means nothing to recall.
     */
    prefetch?: Promise<Attachment | undefined>
  }): Promise<Message.TextPart | undefined> {
    if (hasCurrentUserMemoryPart(input.messages, input.user.id)) return undefined

    // A prefetch result, whether an Attachment or undefined (create decided to skip), means create already ran, so do
    // not recompute it; without a prefetch, compute inline
    const attachment = input.prefetch ? await input.prefetch : await create(input)
    if (!attachment) return undefined

    return {
      id: Identifier.ascending("part"),
      messageID: input.user.id,
      sessionID: input.user.sessionID,
      type: "text",
      text: attachment.text,
      synthetic: true,
      metadata: metadata(attachment),
    }
  }

  export async function create(input: {
    messages: Message.FullMsg[]
    user?: Message.UserInfo
    limit?: number
    memoryDir?: string
  }): Promise<Attachment | undefined> {
    const query = latestUserText(input.messages, input.user).trim()
    if (shouldSkip(query)) return undefined

    const loaded = loadedMemories(input.messages)
    const remaining = MAX_SESSION_BYTES - loaded.totalBytes
    if (remaining <= 0) return undefined

    const exclude = loaded.paths
    const finalLimit = input.limit ?? MAX_SELECTED
    const userModel = input.user?.model
    // Decide once whether to rerank with the LLM: needs finalLimit >= 2, a user.model fallback, and config not off.
    // The same decision widens the keyword stage to the top 15 and triggers the rerank, so the two cannot diverge.
    const rerankEnabled = finalLimit >= 2 && Boolean(userModel) && (await shouldRerank())
    const rankLimit = rerankEnabled ? Math.max(finalLimit, MemoryRerank.CANDIDATE_LIMIT) : finalLimit
    const ranked = rank({
      memories: await MemoryScan.files(input.memoryDir),
      query,
      exclude,
      limit: rankLimit,
    })
    if (ranked.length === 0) return undefined

    // Rerank only with more than one candidate; on failure rerank falls back to the keyword order
    const recentTools = recentToolsFromMessages(input.messages)
    const reranked =
      rerankEnabled && ranked.length > 1 && userModel
        ? await MemoryRerank.rerank({ query, candidates: ranked, fallbackModel: userModel, recentTools })
        : ranked
    const selected = reranked.slice(0, finalLimit)

    const { memories, bytes } = selectWithinBudget(await read(selected), remaining)
    if (memories.length === 0) return undefined

    return {
      query,
      text: render(memories),
      memories,
      paths: memories.map((memory) => memory.path),
      bytes,
    }
  }

  /**
   * LLM reranking is on when recall_rerank is auto (the default) and off when it is off.
   * Returns false without an Instance context (e.g. pure unit tests) to avoid depending on config and providers.
   */
  async function shouldRerank() {
    if (!Instance.has()) return false
    const value = (await Config.get()).memory?.recall_rerank
    return value !== "off"
  }

  /**
   * Automatic recall is off by default and requires memory.auto_recall=true. It is also off while extraction is off,
   * matching the settings page, which locks the dependent toggles.
   * The runner checks this before the per-turn prefetch, so create/part stay pure and unit tests are unaffected.
   */
  export async function enabled(): Promise<boolean> {
    if (!Instance.has()) return false
    const mem = (await Config.get()).memory
    if (resolveExtractPolicy(mem?.auto_extract) === "off") return false
    return mem?.auto_recall === true
  }

  export function latestUserText(messages: Message.FullMsg[], user?: Message.UserInfo) {
    const message = user
      ? messages.find((item) => item.info.id === user.id && item.info.role === "user")
      : messages.findLast((item) => item.info.role === "user")
    if (!message) return ""
    return Message.userTaskText(message)
  }

  /** The N most recently used distinct tool names, newest first, so reranking can take tool use into account */
  export function recentToolsFromMessages(messages: Message.FullMsg[], limit = 10): string[] {
    const tools: string[] = []
    for (let i = messages.length - 1; i >= 0 && tools.length < limit; i--) {
      for (const part of messages[i].parts) {
        if (part.type === "tool" && part.tool && !tools.includes(part.tool)) {
          tools.push(part.tool)
        }
      }
    }
    return tools
  }

  export function loadedMemories(messages: Message.FullMsg[]) {
    const paths = new Set<string>()
    let totalBytes = 0
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.type === "text") {
          const memory = part.metadata?.memory
          if (memory?.kind !== METADATA_KIND) continue
          if (Array.isArray(memory.paths)) {
            for (const item of memory.paths) {
              if (typeof item === "string") paths.add(path.resolve(item))
            }
          }
          if (typeof memory.bytes === "number" && Number.isFinite(memory.bytes)) {
            totalBytes += memory.bytes
          }
          continue
        }

        if (part.type !== "tool" || part.state.status !== "completed") continue
        for (const candidate of toolPathCandidates(part.state)) {
          const resolved = resolvePath(candidate)
          if (resolved && isMemoryTopicPath(resolved)) paths.add(resolved)
        }
      }
    }
    return { paths, totalBytes }
  }

  export function render(memories: Memory[]) {
    return [
      "<system-reminder>",
      "Relevant memories:",
      "",
      [
        "The following memory files may be relevant.",
        "Use them as context, but verify current project state before acting on repo-specific claims.",
      ].join(" "),
      "",
      ...memories.flatMap((memory) => [memory.header, "", memory.content, ""]),
      "</system-reminder>",
    ].join("\n")
  }

  export function rank(input: {
    memories: MemoryScan.Header[]
    query: string
    limit?: number
    exclude?: Iterable<string>
  }) {
    const normalized = normalize(input.query)
    const terms = termsForRank(input.query)
    const exclude = new Set(Array.from(input.exclude ?? []).map((item) => path.resolve(item)))
    const suppressReference = shouldSuppressReference(input.query)
    const available = input.memories.filter((memory) => !exclude.has(path.resolve(memory.path)))
    const ranked = available
      .map((memory) => ({ memory, score: score(memory, normalized, terms, suppressReference) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.memory.mtimeMs - a.memory.mtimeMs)
      .map((item) => item.memory)

    if (ranked.length > 0) return ranked.slice(0, input.limit ?? MAX_SELECTED)
    if (isExplicitRecall(input.query)) {
      return available
        .filter((memory) => !(memory.type === "reference" && suppressReference))
        .slice(0, input.limit ?? MAX_SELECTED)
    }
    return []
  }

  export function metadata(attachment: Pick<Attachment, "paths" | "bytes" | "query">) {
    return {
      memory: {
        kind: METADATA_KIND,
        paths: attachment.paths,
        bytes: attachment.bytes,
        query: attachment.query,
      },
    }
  }

  function shouldSkip(query: string) {
    const text = query.trim()
    if (!text) return true
    if (shouldIgnoreMemory(text)) return true
    return termsForRank(text).length === 0 && text.length < 4
  }

  function shouldIgnoreMemory(query: string) {
    return (
      /\b(ignore|do not use|don't use|without|no)\s+(memory|memories)\b/i.test(query) || IGNORE_MEMORY_CJK.test(query)
    )
  }

  function hasCurrentUserMemoryPart(messages: Message.FullMsg[], userID: string) {
    const message = messages.find((item) => item.info.id === userID && item.info.role === "user")
    return message?.parts.some((part) => part.type === "text" && part.metadata?.memory?.kind === METADATA_KIND) ?? false
  }

  function score(memory: MemoryScan.Header, query: string, terms: string[], suppressReference: boolean) {
    const filename = normalize(memory.filename)
    const name = normalize(memory.name ?? "")
    const description = normalize(memory.description ?? "")
    const type = normalize(memory.type ?? "")
    const filenameTerms = tokenize(memory.filename)
    const nameTerms = tokenize(memory.name ?? "")
    const descriptionTerms = tokenize(memory.description ?? "")
    let total = 0
    let direct = false
    let primaryMatches = 0
    let secondaryMatches = 0

    if (query) {
      if (filename === query || name === query) {
        total += 120
        direct = true
      } else if (filename.startsWith(query) || name.startsWith(query)) {
        total += 72
        direct = true
      } else if (filename.includes(query) || name.includes(query)) {
        total += 48
        direct = true
      }
      if (description.includes(query)) {
        total += 24
        direct = true
      }
    }

    for (const term of terms) {
      const primary =
        termScore({ term, tokens: filenameTerms, haystack: filename, exact: 24, prefix: 18, partial: 12 }) +
        termScore({ term, tokens: nameTerms, haystack: name, exact: 20, prefix: 15, partial: 10 })
      const secondary = termScore({
        term,
        tokens: descriptionTerms,
        haystack: description,
        exact: 10,
        prefix: 7,
        partial: 5,
      })
      const tertiary = type.includes(term) ? 4 : 0

      if (primary > 0) primaryMatches++
      if (secondary > 0) secondaryMatches++
      total += primary + secondary + tertiary
    }

    if (!direct && primaryMatches === 0 && !hasEnoughSecondaryMatches(terms, secondaryMatches)) return 0
    if (primaryMatches + secondaryMatches > 0 && terms.length > 0) {
      total += ((primaryMatches + secondaryMatches) / terms.length) * 6
    }
    if (memory.type === "reference" && suppressReference) return 0
    if (memory.type === "feedback") total += 3
    if (memory.type === "user") total += 2
    return total
  }

  async function read(headers: MemoryScan.Header[]): Promise<Memory[]> {
    const results = await Promise.all(
      headers.map(async (header) => {
        const file = header.path
        const content = await Filesystem.readText(file).catch(() => undefined)
        if (content === undefined) return undefined
        const truncated = truncate(content)
        const memory: Memory = {
          path: header.path,
          content: truncated.content,
          mtimeMs: header.mtimeMs,
          header: memoryHeader(header.path, header.mtimeMs),
        }
        return memory
      }),
    )
    return results.filter((result): result is NonNullable<typeof result> => result !== undefined)
  }

  function selectWithinBudget(memories: Memory[], limit: number) {
    const selected: Memory[] = []
    let bytes = 0
    for (const memory of memories) {
      const size = Buffer.byteLength(memory.content, "utf8")
      if (bytes + size > limit) continue
      selected.push(memory)
      bytes += size
    }
    return {
      memories: selected,
      bytes,
    }
  }

  function truncate(content: string) {
    const lines = content.split(/\r?\n/)
    const kept: string[] = []
    let bytes = 0
    let truncatedByBytes = false
    const max = Math.min(lines.length, MAX_MEMORY_LINES)

    for (let index = 0; index < max; index++) {
      const line = lines[index]
      const size = Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0)
      if (bytes + size > MAX_MEMORY_BYTES) {
        truncatedByBytes = true
        if (kept.length === 0) {
          const prefix = fitBytes(line, MAX_MEMORY_BYTES)
          if (prefix) {
            kept.push(prefix)
            bytes += Buffer.byteLength(prefix, "utf8")
          }
        }
        break
      }
      kept.push(line)
      bytes += size
    }

    const truncatedByLines = lines.length > kept.length
    const truncated = truncatedByBytes || truncatedByLines
    const result = kept.join("\n")
    if (!truncated) return { content: result, truncated }

    const reason = truncatedByBytes ? `${MAX_MEMORY_BYTES} byte limit` : `first ${MAX_MEMORY_LINES} lines`
    return {
      content:
        result +
        `\n\n> This memory file was truncated (${reason}). Use the read tool to view the complete file if needed.`,
      truncated,
    }
  }

  function fitBytes(value: string, limit: number) {
    let bytes = 0
    const kept: string[] = []
    for (const char of value) {
      const size = Buffer.byteLength(char, "utf8")
      if (bytes + size > limit) break
      kept.push(char)
      bytes += size
    }
    return kept.join("")
  }

  /**
   * Human-readable age. Models are bad at date arithmetic, so "2 hours ago" / "3 days ago" conveys freshness better
   * than an ISO timestamp.
   */
  function memoryAge(mtimeMs: number): string {
    const diff = Date.now() - mtimeMs
    const days = Math.floor(diff / 86_400_000)
    if (days === 0) {
      const hours = Math.floor(diff / 3_600_000)
      return hours === 0 ? "just now" : `${hours} hour${hours > 1 ? "s" : ""} ago`
    }
    return `${days} day${days > 1 ? "s" : ""} ago`
  }

  /**
   * Header for an injected memory. Memories older than a day get a staleness warning: a memory is a snapshot from
   * when it was written, and the files, functions or flags it names may have been renamed or removed since. The
   * warning reminds the model that "the memory says X exists" does not mean X still exists.
   */
  function memoryHeader(filePath: string, mtimeMs: number) {
    const age = memoryAge(mtimeMs)
    const stale = Date.now() - mtimeMs > 86_400_000 // older than one day
    const warning = stale
      ? `This memory is ${age} old. Memories are point-in-time observations, not live state - claims may be outdated. Verify against current code before asserting as fact.\n\n`
      : ""
    return `${warning}Memory (saved ${age}): ${filePath}:`
  }

  function toolPathCandidates(state: Message.ToolStateCompleted) {
    const input = state.input
    const metadata = state.metadata
    return [
      input.filePath,
      input.file_path,
      metadata?.filepath,
      metadata?.filePath,
      ...(Array.isArray(metadata?.files) ? metadata.files : []),
    ].filter((item): item is string => typeof item === "string" && item.trim().length > 0)
  }

  function resolvePath(candidate: string) {
    return path.resolve(path.isAbsolute(candidate) ? candidate : path.join(Instance.directory, candidate))
  }

  function isMemoryTopicPath(filePath: string) {
    if (path.basename(filePath) === MemoryPath.ENTRYPOINT_NAME) return false
    if (!filePath.toLowerCase().endsWith(".md")) return false
    const relative = path.relative(MemoryPath.directory(), filePath)
    return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)
  }

  /** \u6784\u9020\u53ec\u56de\u7528 term \u96c6\u5408\uff08\u590d\u7528 {@link TextRank} \u539f\u8bed\uff0c\u4f20\u5165\u53ec\u56de\u573a\u666f\u7684\u505c\u7528\u8bcd\u8868\uff09 */
  function termsForRank(query: string) {
    return textRankTermsForRank(query, STOP_WORDS)
  }

  function shouldSuppressReference(query: string) {
    if (EXTERNAL_REFERENCE_HINT.test(query)) return false
    return INTERNAL_REFERENCE_NOISE.test(query)
  }

  function isExplicitRecall(query: string) {
    return /\b(memory|memories|remember|recall)\b/i.test(query) || EXPLICIT_RECALL_CJK.test(query)
  }
}
