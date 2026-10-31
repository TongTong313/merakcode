import z from "zod"
import { ModelId } from "../model/config"

export namespace MemorySettings {
  export const fields = {
    memory: z
      .object({
        auto_extract: z
          .union([z.boolean(), z.enum(["signals", "always"])])
          .optional()
          .describe(
            "Post-turn memory extraction policy. Default signals (extract only when needed). false disables it; true/signals extracts only on turns with memory signals; always extracts at the end of every root turn; unset means signals.",
          ),
        auto_recall: z
          .boolean()
          .optional()
          .describe(
            "Whether to enable memory recall. Default false (off): past memories are not recalled into the context automatically. true: at the start of every user turn, relevant memories are recalled by keyword (optionally reranked by an LLM) and injected into the context.",
          ),
        model: ModelId.optional().describe(
          "Model for post-turn memory extraction. Defaults to small_model, then the turn model.",
        ),
        recall_rerank: z
          .enum(["off", "auto"])
          .optional()
          .describe(
            "Rerank strategy for memory recall (only applies when auto_recall=true). off disables it (keyword scoring only); auto reranks the top-N candidates with the small model when memory.model/small_model is configured, and falls back to keyword scoring when it is not configured or the call fails.",
          ),
        session_memory: z
          .boolean()
          .optional()
          .describe(
            "Whether to enable SessionMemory (session notes). Default true (on). When on, a forked small model maintains per-session notes at token thresholds (10K to start, then every 5K) so context can be restored after compaction. Set false to turn it off completely.",
          ),
        session_memory_compact: z
          .boolean()
          .optional()
          .describe(
            "Use the SessionMemory notes instead of an LLM summary during compaction (saves one LLM call). Default true (on). Only applies when session_memory is not disabled; falls back to the LLM summary automatically when the notes are empty or fail. Set false to always use the LLM summary.",
          ),
        extract_interval: z
          .number()
          .optional()
          .describe(
            "Memory extraction throttle: extract once every N finished turns, default 1 (every turn). Larger values fork fewer child sessions and save cost.",
          ),
        auto_dream: z
          .boolean()
          .optional()
          .describe(
            "Whether to enable AutoDream (memory consolidation). Default false (off). When on, a child session is forked periodically to review the memory directory and merge, deduplicate, refine and prune the index, consolidating fragmented memories into organized, non-redundant long-term memory. Only applies when auto_extract is on (no extraction means nothing to consolidate).",
          ),
        dream_min_hours: z
          .number()
          .optional()
          .describe(
            "AutoDream time gate: minimum hours since the last consolidation, default 24. Consolidation runs only when dream_min_sessions is also met.",
          ),
        dream_min_sessions: z
          .number()
          .optional()
          .describe(
            "AutoDream session gate: minimum number of new sessions since the last consolidation, default 5. Consolidation runs only when dream_min_hours is also met.",
          ),
      })
      .optional(),
  }
}
