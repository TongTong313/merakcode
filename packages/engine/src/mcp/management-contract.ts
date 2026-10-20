import z from "zod"
import { Config } from "../config/config"
import { McpLocalBase, McpRemoteBase } from "../config/mcp-schema"
import { MCP } from "../mcp"

export namespace McpManagementContract {
  // remote allows an optional transport, matching settings page edits (which keep an explicit transport) and configs
  // of other variants. Extra fields fail validation like any unknown key.
  const ManualMcpRemote = McpRemoteBase.extend({
    transport: z.enum(["http", "sse"]).optional().describe("Explicit remote MCP transport protocol"),
  })
    .strict()
    .meta({ ref: "McpManagementRemoteInput" })

  const ManualMcp = z.discriminatedUnion("type", [
    McpLocalBase.meta({ ref: "McpManagementLocalInput" }),
    ManualMcpRemote,
  ])

  export const Server = z.object({
    name: z.string(),
    scope: z.enum(["project", "global"]),
    shadowed: z.array(z.enum(["project", "global"])),
    enabled: z.boolean(),
    config: Config.Mcp,
    status: MCP.Status,
    tools: z.object({
      count: z.number().int().nonnegative(),
      tools: z.array(z.string()),
    }),
  })
  export type Server = z.infer<typeof Server>

  export const Snapshot = z.object({
    servers: z.array(Server),
  })
  export type Snapshot = z.infer<typeof Snapshot>

  export const Command = z.discriminatedUnion("type", [
    z.object({
      type: z.literal("add"),
      name: z.string().trim().min(1),
      config: ManualMcp,
    }),
    z.object({
      type: z.literal("replace"),
      name: z.string().trim().min(1),
      config: ManualMcp,
    }),
    z.object({
      type: z.literal("rename"),
      name: z.string().trim().min(1),
      newName: z.string().trim().min(1),
    }),
    z.object({
      type: z.literal("remove"),
      name: z.string().trim().min(1),
    }),
    z.object({
      type: z.literal("set_enabled"),
      name: z.string().trim().min(1),
      enabled: z.boolean(),
    }),
  ])
  export type Command = z.infer<typeof Command>
  export type CommandInput = z.input<typeof Command>

  export const ErrorInfo = z.object({
    code: z.enum([
      "already_exists",
      "not_found",
      "shadowed",
      "invalid_config",
      "runtime_connect_failed",
      "runtime_disconnect_failed",
      "config_write_failed",
      "compensation_failed",
    ]),
    message: z.string(),
    facts: z.array(
      z.object({
        stage: z.enum(["runtime", "config", "compensation"]),
        action: z.string(),
        ok: z.boolean(),
        message: z.string().optional(),
      }),
    ),
  })
  export type ErrorInfo = z.infer<typeof ErrorInfo>

  export const Result = z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), snapshot: Snapshot }),
    z.object({ ok: z.literal(false), error: ErrorInfo, snapshot: Snapshot.optional() }),
  ])
  export type Result = z.infer<typeof Result>
}
