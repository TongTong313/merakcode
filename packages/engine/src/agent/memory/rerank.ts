/**
 * LLM reranking for memory recall.
 *
 * Keyword scoring picks the top-N candidates, a small model reads the query plus each candidate's
 * name/description/type and returns ids ordered by relevance, and the top-K bodies are read and injected.
 *
 * Trade-offs:
 * - Rerank only, no generative retrieval (too costly and slow); the result stays explainable and can fall back.
 * - No child session or ReAct loop: a single LLM.stream text call, like title generation in summary.ts.
 * - Does not borrow an existing hidden agent such as title, whose prompt ("output only a title, never answer")
 *   conflicts with reranking. A minimal Agent.Info with an empty prompt leaves the system prompt entirely to
 *   {@link RERANK_SYSTEM_PROMPT}.
 * - Without a small model, or when the call fails, keeps the keyword order instead of blocking recall.
 */
import { Log } from "@merakcode/log/logger"
import { Config } from "@merakcode/engine/agent/settings/index"
import { Provider } from "../model/provider"
import { LLM } from "../model/llm"
import type { Agent } from "../agent"
import type { Message } from "../session/message"
import { MemoryScan } from "./scan"

export namespace MemoryRerank {
  const log = Log.create({ service: "memory.rerank" })

  /** Candidates taken from keyword scoring for the LLM to rerank; recall's MAX_SELECTED still caps what is injected */
  export const CANDIDATE_LIMIT = 15

  /**
   * Minimal agent for reranking. Its prompt is empty and {@link LLM.stream} runs with systemPrepared=true, so the
   * system prompt is exactly {@link RERANK_SYSTEM_PROMPT}; a hidden agent such as title would bring its own prompt
   * ("output only a title, never answer questions"), which conflicts with reranking.
   */
  const RERANK_AGENT: Agent.Info = {
    id: "memory-rerank",
    name: "memory-rerank",
    mode: "primary",
    native: true,
    hidden: true,
    permission: [],
    options: {},
  }

  const RERANK_SYSTEM_PROMPT = [
    "You are a memory retrieval reranker. Given the user's query, rank the candidate memories from most to least relevant.",
    "Output only the indexes of entries you consider relevant; leave out uncertain ones; output an empty array if none are relevant.",
    "If a list of recently used tools is provided, do not pick API-documentation memories for those tools (the model is already using them), but still pick memories with warnings, gotchas, or known issues.",
    'Output strictly JSON only: {"rank":[index,index,...]}, with no other text or explanation.',
  ].join("\n")

  /**
   * Reranks candidate memories with a small model.
   * @param query the user's query text
   * @param candidates candidates from keyword scoring, highest score first
   * @returns the reranked candidates; the original candidates on failure
   */
  export async function rerank(input: {
    query: string
    candidates: MemoryScan.Header[]
    fallbackModel: Message.UserInfo["model"]
    recentTools?: string[]
  }): Promise<MemoryScan.Header[]> {
    if (input.candidates.length <= 1) return input.candidates

    const model = await resolveModel(input.fallbackModel)
    if (!model) {
      log.warn("memory rerank skipped: no small model available, falling back to keyword order")
      return input.candidates
    }

    // Give each candidate a stable index so the LLM returns indexes rather than file names, which avoids ambiguity
    // and escaping problems
    const indexed = input.candidates.map((header, index) => ({
      index,
      name: header.name ?? header.filename,
      description: header.description ?? "",
      type: header.type ?? "",
    }))

    const prompt = buildPrompt(input.query, indexed, input.recentTools)
    try {
      const stream = await LLM.stream({
        agent: RERANK_AGENT,
        user: {
          id: "rerank",
          sessionID: "rerank",
          role: "user",
          agent: RERANK_AGENT.id,
          model: { providerID: model.providerID, modelID: model.id },
          time: { created: 0 },
        } as Message.UserInfo,
        tools: {},
        model,
        small: true,
        messages: [{ role: "user", content: prompt }],
        abort: new AbortController().signal,
        sessionID: "rerank",
        // systemPrepared=true skips prepareSystem, so neither agent.prompt nor the provider's default system prompt
        // is mixed into the rerank instructions
        system: [RERANK_SYSTEM_PROMPT],
        systemPrepared: true,
        retries: 1,
      })
      const text = (await stream.text).trim()
      const order = parseOrder(text, indexed.length)
      if (order.length === 0) {
        log.warn("memory rerank produced no parseable order, falling back to keyword order", { text })
        return input.candidates
      }

      const byIndex = new Map(input.candidates.map((h, i) => [i, h]))
      const reranked = order.map((i) => byIndex.get(i)).filter((h): h is MemoryScan.Header => !!h)
      // Append candidates the LLM left out so a small model omitting entries does not drop them
      for (let i = 0; i < input.candidates.length; i++) {
        if (!order.includes(i)) reranked.push(input.candidates[i]!)
      }
      return reranked
    } catch (error) {
      log.warn("memory rerank failed, falling back to keyword order", { error })
      return input.candidates
    }
  }

  /**
   * Parses the index list from the model output: JSON {"rank":[...]} first, then free text like <rank>2,0,5</rank>,
   * since small models occasionally ignore the JSON format.
   */
  function parseOrder(text: string, count: number): number[] {
    const jsonOrder = parseJsonOrder(text, count)
    if (jsonOrder) return jsonOrder

    const match = text.match(/<rank>([\d,\s]+)<\/rank>/)
    if (!match) return []
    const ids = match[1]!
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isInteger(n) && n >= 0 && n < count)
    return Array.from(new Set(ids))
  }

  /** Reads the rank array from JSON in the text, including JSON wrapped in extra prose */
  function parseJsonOrder(text: string, count: number): number[] | undefined {
    for (const candidate of extractJsonCandidates(text)) {
      try {
        const parsed = JSON.parse(candidate) as { rank?: unknown }
        if (!Array.isArray(parsed.rank)) continue
        const ids = parsed.rank
          .map((n) => (typeof n === "number" ? n : Number.parseInt(String(n), 10)))
          .filter((n) => Number.isInteger(n) && n >= 0 && n < count)
        return Array.from(new Set(ids))
      } catch {
        // try the next candidate
      }
    }
    return undefined
  }

  /** Possible JSON fragments: the whole text plus the first balanced {...} substring */
  function extractJsonCandidates(text: string): string[] {
    const candidates = [text]
    const embedded = extractBalancedJsonObject(text)
    if (embedded && embedded !== text) candidates.push(embedded)
    return candidates
  }

  function extractBalancedJsonObject(text: string): string | null {
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

  function buildPrompt(
    query: string,
    indexed: { index: number; name: string; description: string; type: string }[],
    recentTools?: string[],
  ) {
    const lines = indexed.map(
      (item) => `[#${item.index}] ${item.type || "unknown"} | ${item.name} | ${item.description}`,
    )
    const toolsSection =
      recentTools && recentTools.length > 0 ? `\n\nRecently used tools: ${recentTools.join(", ")}` : ""
    return (
      [
        `<query>${query}</query>`,
        "",
        "<candidates>",
        ...lines,
        "</candidates>",
        "",
        'Output the indexes of the most relevant candidates (most relevant first), strictly in the format: {"rank":[index,index,...]}',
      ].join("\n") + toolsSection
    )
  }

  /** Rerank model: memory.model, then small_model, then the provider's default small model; undefined if none */
  async function resolveModel(fallback: Message.UserInfo["model"]) {
    const cfg = await Config.get()
    const raw = cfg.memory?.model ?? cfg.small_model
    if (typeof raw === "string" && raw.trim()) {
      try {
        const parsed = Provider.parseModel(raw)
        return await Provider.getModel(parsed.providerID, parsed.modelID)
      } catch (error) {
        log.warn("memory rerank: failed to parse configured memory/small model", { raw, error })
      }
    }
    // Without a configured model, use the fallback provider's default small model
    return Provider.getSmallModel(fallback.providerID).catch((error) => {
      log.warn("memory rerank: no platform small model for provider, skipping", {
        providerID: fallback.providerID,
        error,
      })
      return undefined
    })
  }
}
