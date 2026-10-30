import z from "zod"

export namespace ContextSettings {
  export const fields = {
    compaction: z
      .object({
        auto: z.boolean().optional().describe("Enable automatic compaction when context is full (default: true)"),
        prune: z.boolean().optional().describe("Enable pruning of old tool outputs (default: true)"),
        reserved: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Token buffer for compaction. Leaves enough window to avoid overflow during compaction."),
        failureThreshold: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "After this many consecutive auto-compaction failures, trip the breaker and switch to aggressive prune + blocking limit (default 3)",
          ),
        blockingLimit: z
          .boolean()
          .optional()
          .describe(
            "After the breaker trips, hard-stop and notify the user if the context still exceeds capacity (default true)",
          ),
        lossless: z
          .union([
            z.boolean(),
            z
              .object({
                enabled: z.boolean().optional(),
                min_bytes: z.number().int().min(0).optional(),
                max_block_fold_bytes: z.number().int().min(0).optional(),
              })
              .strict(),
          ])
          .optional()
          .describe(
            "Lossless folding of tool output (default true). Strips ANSI color codes and folds adjacent repeated lines, repeated blocks and repeated path prefixes; every transform is round-trip checked and skipped if it cannot be restored exactly. No information is lost, and it runs before lossy compaction and truncation.",
          ),
        read_lifecycle: z
          .union([
            z.boolean(),
            z
              .object({
                enabled: z.boolean().optional(),
                stale: z
                  .boolean()
                  .optional()
                  .describe("Handle Reads whose content is outdated (a quality issue, default true)"),
                superseded: z
                  .boolean()
                  .optional()
                  .describe("Handle redundant repeated Reads (saves space, default true)"),
                min_size_bytes: z.number().int().min(0).optional(),
                recent_turns: z
                  .number()
                  .int()
                  .min(0)
                  .optional()
                  .describe(
                    "Protection window: Reads within the last N user turns are not replaced, to keep the prompt cache stable (default 2)",
                  ),
              })
              .strict(),
          ])
          .optional()
          .describe(
            "Read lifecycle management (default true). Projection layer: a Read is marked stale when the same file is edited afterwards, and superseded when it is read again with an overlapping range; either is replaced with a short notice. Storage is untouched and this is recomputed every turn. Reads within the last recent_turns turns are left alone to keep the cache.",
          ),
        input_budget: z
          .union([
            z.boolean(),
            z
              .object({
                enabled: z
                  .boolean()
                  .optional()
                  .describe("Whether to truncate tool input content (default true). Set false to disable."),
                share: z
                  .number()
                  .optional()
                  .describe("Dynamic budget share: budget = clamp(usable * share, min, max), default 0.1"),
                min: z.number().optional().describe("Lower bound of the dynamic budget in tokens, default 4000"),
                max: z.number().optional().describe("Upper bound of the dynamic budget in tokens, default 20000"),
                max_chars_per_field: z
                  .number()
                  .optional()
                  .describe("Maximum length of a single content field after truncation (characters), default 4000"),
              })
              .strict(),
          ])
          .optional()
          .describe(
            "Tool input content truncation (on by default). Projection layer: content fields in write/edit/multi_edit/apply_patch inputs that exceed the dynamic budget are truncated (filePath/path are kept) and a marker says the file can be re-read with Read. Independent of output cleanup and its dynamic budget. Inputs within the last recent_turns turns are not truncated, to keep the cache.",
          ),
      })
      .optional(),
  }
}
