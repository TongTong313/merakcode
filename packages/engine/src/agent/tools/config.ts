import z from "zod"

export namespace ToolSettings {
  export const fields = {
    tools: z.record(z.string(), z.boolean()).optional(),
    tool_discovery: z
      .object({
        auto_activate: z
          .boolean()
          .optional()
          .describe(
            "Auto-activate deferred tools on a strong match (default true). When a word in the user's request exactly matches an id segment or alias of a deferred tool, its full schema is injected in this turn, so the model does not need an extra tool_search round. Set false to go back to the old behavior where the model discovers tools on its own.",
          ),
        rerank: z
          .enum(["off", "auto"])
          .optional()
          .describe(
            "Small-model selection for deferred tool search (default off). off uses keyword scoring only; auto, when the candidate count reaches the threshold (mostly with many MCP servers) and small_model is configured, lets the small model pick and activate the tools that are actually needed. Falls back to keywords only when not configured, on timeout or on failure.",
          ),
      })
      .optional(),
  }
}
