import { CommonSettings } from "../../infra/config/fields"
import { Log } from "@merakcode/log/logger"
import { Text } from "../prompt/text"
import { WatcherSettings } from "../../infra/file/config"
import { ProjectSettings } from "../../infra/project/config"
import { StorageSettings } from "../../infra/storage/config"
import { MemorySettings } from "../memory/config"
import { ContextSettings } from "../context/config"
import { ToolSettings } from "../tools/config"
import { LoopSettings } from "../loop/config"
import { PluginSettings } from "../plugin/config"
import { AgentSettings } from "../config"
import { ModelSettings } from "../model/config"
import { McpSettings } from "../mcp/config"
import { ExternalSettings } from "../external/config"
import { CommandSettings } from "../prompt/command/config"
import { RuleSettings } from "../prompt/rules/config"
import { SkillSettings } from "../skill/config"
import { PermissionSettings } from "../permission/config"
import { LspSettings } from "../lsp/config"
import { FormatSettings } from "../format/config"
import z from "zod"
import { McpConfig } from "../../agent/mcp/config"
import { AgentConnectionConfig } from "../../agent/external/config"
import { CommandConfig } from "../../agent/prompt/command/config"
import { SkillConfig } from "../../agent/skill/config"
import { RuleConfig } from "../../agent/prompt/rules/config"
import { ProviderConfig } from "../../agent/model/config"
import { PermissionConfig } from "../../agent/permission/config"
import { AgentConfig } from "../../agent/config"

export namespace CoreConfig {
  export const McpLocal = McpConfig.McpLocal
  export const McpRemote = McpConfig.McpRemote
  export const Mcp = McpConfig.Mcp
  export type Mcp = McpConfig.Mcp

  export const ProductModel = AgentConnectionConfig.ProductModel
  export const AgentConnectionProduct = AgentConnectionConfig.AgentConnectionProduct
  export type AgentConnectionProduct = AgentConnectionConfig.AgentConnectionProduct

  export const Command = CommandConfig.Command
  export type Command = CommandConfig.Command

  export const Skills = SkillConfig.Skills
  export type Skills = SkillConfig.Skills

  export const Rules = RuleConfig.Rules
  export type Rules = RuleConfig.Rules

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

  export const Info = z
    .object({
      $schema: CommonSettings.fields.$schema,
      locale: Text.LocaleConfig,
      logLevel: Log.ConfigLevel,
      command: CommandSettings.fields.command,
      skills: SkillSettings.fields.skills,
      watcher: WatcherSettings.fields.watcher,
      plugin: PluginSettings.fields.plugin,
      agentConnections: ExternalSettings.fields.agentConnections,
      snapshot: ProjectSettings.fields.snapshot,
      disabled_providers: ModelSettings.fields.disabled_providers,
      enabled_providers: ModelSettings.fields.enabled_providers,
      model: ModelSettings.fields.model,
      small_model: ModelSettings.fields.small_model,
      default_agent: AgentSettings.fields.default_agent,
      mode: AgentSettings.fields.mode,
      agent: AgentSettings.fields.agent,
      provider: ModelSettings.fields.provider,
      mcp: McpSettings.fields.mcp,
      formatter: FormatSettings.fields.formatter,
      lsp: LspSettings.fields.lsp,
      instructions: RuleSettings.fields.instructions,
      rules: RuleSettings.fields.rules,
      permission: PermissionSettings.fields.permission,
      tools: ToolSettings.fields.tools,
      enterprise: ModelSettings.fields.enterprise,
      compaction: ContextSettings.fields.compaction,
      memory: MemorySettings.fields.memory,
      tool_discovery: ToolSettings.fields.tool_discovery,
      experimental: LoopSettings.fields.experimental,
      plugin_options: PluginSettings.fields.plugin_options,
      storage: StorageSettings.fields.storage,
      sandbox: PermissionSettings.fields.sandbox,
    })
    .strip()
  export type Info = z.output<typeof Info>
}
