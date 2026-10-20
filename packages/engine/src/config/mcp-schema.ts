import z from "zod"

export const McpLocalBase = z
  .object({
    type: z.literal("local").describe("Type of MCP server connection"),
    command: z.string().array().describe("Command and arguments to run the MCP server"),
    environment: z
      .record(z.string(), z.string())
      .optional()
      .describe("Environment variables to set when running the MCP server"),
    enabled: z.boolean().optional().describe("Enable or disable the MCP server on startup"),
    timeout: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Timeout in ms for MCP server requests. Defaults to 5000 (5 seconds) if not specified."),
    // Deferred MCP tools: only an explicit true keeps them out of the tools array. They are listed by name in
    // tool_search, and once the model activates one its full schema is injected on the next turn. Unset or false
    // keeps them registered eagerly, which suits servers with few, frequently used tools (no activation round trip).
    deferred: z
      .boolean()
      .optional()
      .describe(
        "Set true to defer-load this server's tools via tool_search to reduce per-turn token cost. Defaults to false: tools stay registered eagerly.",
      ),
  })
  .strict()

export const McpRemoteBase = z
  .object({
    type: z.literal("remote").describe("Type of MCP server connection"),
    url: z.string().describe("URL of the remote MCP server"),
    enabled: z.boolean().optional().describe("Enable or disable the MCP server on startup"),
    headers: z.record(z.string(), z.string()).optional().describe("Headers to send with the request"),
    // Same as OpenCode v1.16.2: false means headers only; omitted or an object allows OAuth.
    oauth: z
      .union([
        z.literal(false),
        z
          .object({
            clientId: z.string().optional().describe("Pre-registered OAuth client id"),
            clientSecret: z.string().optional().describe("Pre-registered OAuth client secret"),
            scope: z.string().optional().describe("OAuth scope"),
          })
          .strict(),
      ])
      .optional()
      .describe("Remote MCP OAuth. Set false to keep header auth only."),
    timeout: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Timeout in ms for MCP server requests. Defaults to 5000 (5 seconds) if not specified."),
    // Same as McpLocalBase.deferred: only an explicit true defers the tools.
    deferred: z
      .boolean()
      .optional()
      .describe(
        "Set true to defer-load this server's tools via tool_search to reduce per-turn token cost. Defaults to false: tools stay registered eagerly.",
      ),
  })
  .strict()
