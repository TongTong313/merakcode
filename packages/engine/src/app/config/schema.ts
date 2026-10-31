import { CoreConfig } from "../../agent/settings/schema"
import z from "zod"
import { McpConfig } from "../../agent/mcp/config"
import { AgentConnectionConfig } from "../../agent/external/config"
import { CollaborationConfig } from "../task/collaboration/config"
import { CommandConfig } from "../../agent/prompt/command/config"
import { SkillConfig } from "../../agent/skill/config"
import { RuleConfig } from "../../agent/prompt/rules/config"
import { ServerConfig } from "../server/config"
import { ProviderConfig } from "../../agent/model/config"
import { PermissionConfig } from "../../agent/permission/config"
import { AgentConfig } from "../../agent/config"

export namespace AppConfig {
  export const McpLocal = McpConfig.McpLocal
  export const McpRemote = McpConfig.McpRemote
  export const Mcp = McpConfig.Mcp
  export type Mcp = McpConfig.Mcp

  export const ProductModel = AgentConnectionConfig.ProductModel
  export const AgentConnectionProduct = AgentConnectionConfig.AgentConnectionProduct
  export type AgentConnectionProduct = AgentConnectionConfig.AgentConnectionProduct

  export const RoleTemplate = CollaborationConfig.RoleTemplate

  export const Command = CommandConfig.Command
  export type Command = CommandConfig.Command

  export const Skills = SkillConfig.Skills
  export type Skills = SkillConfig.Skills

  export const Rules = RuleConfig.Rules
  export type Rules = RuleConfig.Rules

  export const Server = ServerConfig.Server

  export const Provider = ProviderConfig.Provider
  export type Provider = ProviderConfig.Provider

  export const PermissionAction = PermissionConfig.PermissionAction
  export type PermissionAction = PermissionConfig.PermissionAction
  export const PermissionObject = PermissionConfig.PermissionObject
  export type PermissionObject = PermissionConfig.PermissionObject
  export const PermissionRule = PermissionConfig.PermissionRule
  export type PermissionRule = PermissionConfig.PermissionRule
  export const Permission = PermissionConfig.Permission
  export type Permission = PermissionConfig.Permission

  export const Agent = AgentConfig.Agent
  export type Agent = AgentConfig.Agent

  export const Layout = z.enum(["auto", "stretch"]).meta({
    ref: "LayoutConfig",
  })
  export type Layout = z.infer<typeof Layout>

  const SharedInfo = z
    .object({
      $schema: CoreConfig.Info.shape.$schema,
      locale: CoreConfig.Info.shape.locale,
      logLevel: CoreConfig.Info.shape.logLevel,
      server: Server.optional().describe("Server configuration for merak serve and web commands"),
      command: CoreConfig.Info.shape.command,
      skills: CoreConfig.Info.shape.skills,
      watcher: CoreConfig.Info.shape.watcher,
      /**
       * Plugin list, same shape as @opencode-ai/sdk@1.16.2: a package specifier string or a `[name, options]` tuple.
       * The tuple's options are passed as the second argument of `server(input, options)` and merged into
       * `PluginInput.options`.
       *
       * Tuples are accepted because configs written for opencode contain them; accepting only strings would make
       * zod reject the whole config. `plugin_options`, keyed by plugin id, is the other supported form.
       */
      plugin: CoreConfig.Info.shape.plugin,
      agentConnections: CoreConfig.Info.shape.agentConnections,
      collaboration: z
        .object({
          roleTemplates: z.record(z.string(), RoleTemplate).optional(),
        })
        .optional()
        .describe("Collaboration groups. The leader is always a Merak seat."),
      snapshot: CoreConfig.Info.shape.snapshot,
      disabled_providers: CoreConfig.Info.shape.disabled_providers,
      enabled_providers: CoreConfig.Info.shape.enabled_providers,
      model: CoreConfig.Info.shape.model,
      small_model: CoreConfig.Info.shape.small_model,
      default_agent: CoreConfig.Info.shape.default_agent,
      mode: CoreConfig.Info.shape.mode,
      agent: CoreConfig.Info.shape.agent,
      provider: CoreConfig.Info.shape.provider,
      mcp: CoreConfig.Info.shape.mcp,
      formatter: CoreConfig.Info.shape.formatter,
      lsp: CoreConfig.Info.shape.lsp,
      instructions: CoreConfig.Info.shape.instructions,
      rules: CoreConfig.Info.shape.rules,
      layout: Layout.optional().describe("@deprecated Always uses stretch layout."),
      permission: CoreConfig.Info.shape.permission,
      tools: CoreConfig.Info.shape.tools,
      enterprise: CoreConfig.Info.shape.enterprise,
      compaction: CoreConfig.Info.shape.compaction,
      memory: CoreConfig.Info.shape.memory,
      tool_discovery: CoreConfig.Info.shape.tool_discovery,
      experimental: CoreConfig.Info.shape.experimental,
      /** UI preferences shared across clients (model visibility, chat scrolling), synced through global.config */
      ui: z
        .object({
          models: z
            .object({
              hidden: z.array(z.string()).optional().describe("Hidden models, as providerID/modelID"),
              recent: z.array(z.string()).optional().describe("Recently used models, as providerID/modelID"),
              variant: z.record(z.string(), z.string()).optional().describe("Selected variant per model"),
            })
            .optional(),
          chat: z
            .object({
              autoScroll: z.boolean().optional().describe("Auto-scroll the conversation to the bottom"),
            })
            .optional(),
        })
        .optional(),
      /**
       * Plugin config namespace, keyed by plugin id. The engine does not interpret the values; each plugin validates
       * its own section with zod in its `config` hook.
       */
      plugin_options: CoreConfig.Info.shape.plugin_options,
      /** Session storage; read from the global config only */
      storage: CoreConfig.Info.shape.storage,
    })
    .strip()
    .meta({
      ref: "Config",
    })

  export const Info = SharedInfo.extend({
    sandbox: CoreConfig.Info.shape.sandbox,
  }).meta({ ref: "Config" })
  export type Info = z.output<typeof Info>
}
