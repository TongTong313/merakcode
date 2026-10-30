import z from "zod"

export namespace LoopSettings {
  export const fields = {
    experimental: z
      .object({
        disable_paste_summary: z.boolean().optional(),
        bash_output_compaction: z
          .union([
            z.boolean(),
            z
              .object({
                enabled: z.boolean().optional(),
                mode: z.enum(["safe", "aggressive"]).optional(),
                session_delta: z.boolean().optional(),
                min_bytes: z.number().int().min(0).optional(),
                max_input_bytes: z.number().int().min(0).optional(),
                max_output_bytes: z.number().int().min(0).optional(),
              })
              .strict(),
          ])
          .optional()
          .describe("Enable Bash output compaction, or configure thresholds for the compactor."),
        tool_result_delta: z
          .boolean()
          .optional()
          .describe("Collapse unchanged repeated glob/grep/ls results within a short session TTL."),
        primary_tools: z
          .array(z.string())
          .optional()
          .describe("Tools that should only be available to primary agents."),
        continue_loop_on_deny: z.boolean().optional().describe("Continue the agent loop when a tool call is denied"),
        mcp_timeout: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Timeout in milliseconds for model context protocol (MCP) requests"),
      })
      .optional(),
  }
}
