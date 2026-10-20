import { Config } from "../config/config"
import { Provider } from "../provider/provider"
import { LLM } from "../session/llm"
import type { Message } from "../session/message"
import type { Agent } from "../agent/agent"
import { Log } from "@merakcode/log/logger"
import { parseIndexArray } from "../util/json-extract"
import type { DeferredToolSummary } from "./tool-search"

/**
 * Stage B of deferred tool discovery: selection by a small model (side query).
 *
 * Why keywords come first and the small model second:
 * - Stage A's deterministic scoring is free and narrows the candidates to the top N; without it the whole MCP tool
 *   list would go into the side query prompt, at unbounded cost.
 * - The side query adds 300-800 ms on the critical path of the turn's LLM call. With the small model first, a
 *   failure would pay that latency and still need the keyword pass.
 * - memory/rerank.ts uses the same order.
 *
 * Why it is off by default and needs a candidate threshold: without MCP, the deferred set is only four built-in tools
 * (pdf_parse / excel_parse / excel_write / workflow_run) whose ids are good search keys, so Stage A almost always
 * hits and the small model only adds cost. It pays off with many MCP tools: dozens of opaque ids
 * (`${server}_${tool}`) that share no tokens with Chinese queries, where keywords fail. So it only runs when there
 * are at least {@link MIN_CANDIDATES} candidates.
 *
 * Any failure degrades to selecting nothing (an empty array) and never blocks the turn.
 */
export namespace ToolDiscoveryRerank {
  const log = Log.create({ service: "tool.discovery.rerank" })

  /**
   * Minimum number of candidates for a side query; below it Stage A is enough and the latency is not worth it.
   *
   * The caller checks this against all candidates awaiting activation in the turn, not select against the shortlist
   * it receives: the shortlist is Stage A's sorted subset, and using it would block exactly the case that most needs
   * the small model, such as 50 candidates with only 5 weak keyword hits.
   */
  export const MIN_CANDIDATES = 12

  /** Most candidates sent to the small model (same as MemoryRerank.CANDIDATE_LIMIT) */
  export const CANDIDATE_LIMIT = 15

  /** Most tools the small model may select; each selection loads a full schema, so this must be capped */
  export const SELECT_LIMIT = 2

  /**
   * Hard timeout. memory/rerank.ts has none (only retries: 1), but this runs on the critical path before every LLM
   * call, so it needs an upper bound; on timeout the Stage A result is used.
   */
  export const TIMEOUT_MS = 1500

  /**
   * Minimal agent for selection: its prompt is empty and, with systemPrepared=true in {@link LLM.stream}, the system
   * prompt is exactly {@link SELECT_SYSTEM_PROMPT} (same shape as MemoryRerank.RERANK_AGENT).
   */
  const SELECT_AGENT: Agent.Info = {
    id: "tool-discovery",
    name: "tool-discovery",
    mode: "primary",
    native: true,
    hidden: true,
    permission: [],
    options: {},
  }

  const SELECT_SYSTEM_PROMPT = [
    "You are a tool selector. Given a user request and a set of candidate tools that are not loaded yet, pick the tools that are **clearly required** to complete the request.",
    "Only pick a tool when you are confident it is necessary for the request; if unsure, leave it out. Prefer picking too few over too many.",
    "If no candidate tool is relevant to the request, return an empty array.",
    'Output strictly JSON only: {"select":[index,index]}, with no other text or explanation.',
  ].join("\n")

  /**
   * Asks the small model to pick the tools the request actually needs.
   *
   * Check {@link MIN_CANDIDATES} against all candidates awaiting activation before calling.
   *
   * @param query the user's request in this turn
   * @param candidates the Stage A shortlist, without tools that are already active or were pruned
   * @returns the selected tool ids; [] when no small model is available, on timeout, or when parsing fails
   */
  export async function select(input: {
    query: string
    candidates: readonly DeferredToolSummary[]
    fallbackProviderID: string
  }): Promise<string[]> {
    const query = input.query.trim()
    if (!query || input.candidates.length === 0) return []

    const model = await resolveModel(input.fallbackProviderID)
    if (!model) {
      log.warn("tool discovery rerank skipped: no small model available")
      return []
    }

    // Only the top N, with stable indexes so the model answers with numbers rather than tool names, which avoids
    // escaping problems and misspelled names
    const shortlist = input.candidates.slice(0, CANDIDATE_LIMIT)
    const prompt = buildPrompt(query, shortlist)

    try {
      const stream = await LLM.stream({
        agent: SELECT_AGENT,
        user: {
          id: "tool-discovery",
          sessionID: "tool-discovery",
          role: "user",
          agent: SELECT_AGENT.id,
          model: { providerID: model.providerID, modelID: model.id },
          time: { created: 0 },
        } as Message.UserInfo,
        tools: {},
        model,
        small: true,
        messages: [{ role: "user", content: prompt }],
        // On timeout the call aborts and the catch returns [], falling back to the Stage A result
        abort: AbortSignal.timeout(TIMEOUT_MS),
        sessionID: "tool-discovery",
        system: [SELECT_SYSTEM_PROMPT],
        systemPrepared: true,
        retries: 1,
      })
      const text = (await stream.text).trim()
      const picked = parseIndexArray(text, "select", shortlist.length)
      if (!picked || picked.length === 0) return []
      return picked.slice(0, SELECT_LIMIT).map((index) => shortlist[index]!.id)
    } catch (error) {
      log.warn("tool discovery rerank failed, falling back to keyword result", { error })
      return []
    }
  }

  function buildPrompt(query: string, candidates: readonly DeferredToolSummary[]) {
    const lines = candidates.map((tool, index) => {
      // Prefer the one-line summary; MCP tools without one fall back to the start of searchText
      const desc = tool.summary || tool.searchText?.split("\n")[0]?.slice(0, 160) || ""
      return `[#${index}] ${tool.id}${desc ? ` | ${desc}` : ""}`
    })
    return [
      `<request>${query}</request>`,
      "",
      "<candidate_tools>",
      ...lines,
      "</candidate_tools>",
      "",
      'Output the indexes of the tools clearly required to complete the request, strictly in the format: {"select":[index,index]}',
    ].join("\n")
  }

  /** Configured small_model, else the platform's default small model; undefined when neither exists */
  async function resolveModel(fallbackProviderID: string) {
    const cfg = await Config.get()
    const raw = cfg.small_model
    if (typeof raw === "string" && raw.trim()) {
      try {
        const parsed = Provider.parseModel(raw)
        return await Provider.getModel(parsed.providerID, parsed.modelID)
      } catch (error) {
        log.warn("tool discovery rerank: failed to parse configured small_model", { raw, error })
      }
    }
    return Provider.getSmallModel(fallbackProviderID).catch((error) => {
      log.warn("tool discovery rerank: no platform small model for provider, skipping", {
        providerID: fallbackProviderID,
        error,
      })
      return undefined
    })
  }
}
