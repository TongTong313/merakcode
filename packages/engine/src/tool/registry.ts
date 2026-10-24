import { QuestionTool } from "./question"
import { pathToFileURL } from "node:url"
import { BashTool } from "./bash"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { ReadTool } from "./read"
import { PdfParseTool } from "./pdf-parse"
import { ExcelParseTool } from "./excel-parse"
import { ExcelWriteTool } from "./excel-write"
import { DocxParseTool } from "./docx-parse"
import { DelegateTool } from "./delegate"
import { SubAgentTool } from "./subagent"
import { TodoWriteTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import { RuleTool } from "./rule"
import { CronCreateTool, CronListTool, CronDeleteTool } from "./loop"
import type { Agent } from "../agent/agent"
import { Tool } from "./tool"
import type { Message } from "../session/message"
import { Instance } from "../project/instance"
import { Config } from "../config/config"
import path from "path"
import { normalizeToolResult, type ToolContext as PluginToolContext, type ToolDefinition } from "@merakcode/sdk/plugin"
import z from "zod"
import { Plugin } from "../plugin"
import { WebSearchTool } from "./websearch"
import { CodeSearchTool } from "./codesearch"
import { Flag } from "../flag/flag"
import { Log } from "@merakcode/log/logger"
import { LspTool } from "./lsp"
import { Truncate } from "./truncation"
import { PlanExitTool, PlanEnterTool } from "./plan"
import { WorkflowRunTool } from "./workflow"
import { BashBackgroundTool } from "./bash-background"
import { MultiEditTool } from "./multi_edit"
import { RemoteTool } from "./remote"
import { Glob } from "@merakcode/util/glob"

export namespace ToolRegistry {
  const log = Log.create({ service: "tool.registry" })
  type Origin = "builtin" | "custom"
  type Entry = { tool: Tool.Info; readonly origin: Origin }
  type Initialized = Awaited<ReturnType<Tool.Info["init"]>> &
    Pick<Tool.Info, "id" | "triggerHint"> & { readonly origin: Origin }

  /**
   * Core tools carry MerakCode's path, permission, and safety semantics.
   * A plugin must not silently replace them with an arbitrary implementation.
   */
  export const RESERVED = new Set([
    "bash",
    // Runs commands like bash and carries the same permission semantics
    "bash_background",
    "edit",
    "glob",
    "grep",
    "invalid",
    "multi_edit",
    "read",
    "skill",
    "rule",
    "subagent",
    "delegate",
    "write",
  ])

  export const state = Instance.state(async () => {
    const custom = [] as Tool.Info[]
    const glob = new Glob("{tool,tools}/*.{js,ts}")
    const config = await Config.get()

    const matches = await Config.directories().then((dirs) =>
      dirs
        .flatMap((dir) => [...glob.scanSync({ cwd: dir, absolute: true, followSymlinks: true, dot: true })])
        .filter((match) => {
          const namespace = path.basename(match, path.extname(match))
          if (config.tools?.[namespace] !== false) return true
          log.warn("skipping disabled custom tool", { tool: namespace, path: match })
          return false
        })
        // Glob.scanSync() order depends on the file system. Sorting keeps custom tools at the end of all() in the same
        // order on every run, so the tools array sent to the model keeps a stable prefix for the prompt cache.
        .sort(),
    )
    if (matches.length) await Config.waitForDependencies()
    for (const match of matches) {
      const namespace = path.basename(match, path.extname(match))
      // On Windows, Node's import() does not accept a bare absolute path
      const mod = await import(pathToFileURL(match).href)
      for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
        custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
      }
    }

    const plugins = await Plugin.list()
    for (const plugin of plugins) {
      for (const [id, def] of Object.entries(plugin.tool ?? {})) {
        if (RESERVED.has(id)) {
          log.warn("plugin attempted to override reserved tool", { tool: id })
          continue
        }
        custom.push(fromPlugin(id, def))
      }
    }

    return { custom }
  })

  function fromPlugin(id: string, def: ToolDefinition): Tool.Info {
    return {
      id,
      init: async (initCtx) => ({
        parameters: z.object(def.args),
        description: def.description,
        execute: async (args, ctx) => {
          await ctx.ask({
            permission: id,
            patterns: ["*"],
            metadata: { pluginTool: true },
          })
          const pluginCtx = {
            ...ctx,
            directory: Instance.directory,
            worktree: Instance.worktree,
          } as unknown as PluginToolContext
          // Plugin tools may return a string or, as in opencode 1.16.2, `{ title?, output, metadata?, attachments? }`
          // (ToolResult in @merakcode/sdk/plugin). Both forms are normalized before Truncate.output so plugins ported
          // from opencode do not silently lose their title and metadata.
          const normalized = normalizeToolResult(await def.execute(args as any, pluginCtx))
          const out = await Truncate.output(normalized.output, {}, initCtx?.agent)
          return {
            title: normalized.title ?? "",
            output: out.truncated ? out.content : normalized.output,
            metadata: {
              ...normalized.metadata,
              truncated: out.truncated,
              outputPath: out.truncated ? out.outputPath : undefined,
            },
            attachments: normalized.attachments as Message.FilePart[] | undefined,
          }
        },
      }),
    }
  }

  export async function register(tool: Tool.Info) {
    const { custom } = await state()
    const idx = custom.findIndex((t) => t.id === tool.id)
    if (idx >= 0) {
      custom.splice(idx, 1, tool)
      return
    }
    custom.push(tool)
  }

  /**
   * Tool IDs supplied at runtime by local custom tools, plugins or the SDK host.
   * These do not belong in the static core-tool pool; agents opt into them
   * through the virtual `plugin` capability instead.
   */
  export async function dynamicIds() {
    return customs().then((custom) => new Set(custom.map((tool) => tool.id)))
  }

  /**
   * Project custom tools and plugin tools, plus remote tools registered by the SDK host. The host wins on a name
   * clash; reserved tools cannot be replaced.
   */
  async function customs() {
    const remote = RemoteTool.list()
      .filter((definition) => !RESERVED.has(definition.id))
      .map(RemoteTool.info)
    const names = new Set(remote.map((tool) => tool.id))
    const custom = await state().then((x) => x.custom)
    return [...custom.filter((tool) => !names.has(tool.id)), ...remote]
  }

  /**
   * Clients where someone can answer questions and confirm plans. Without an SDK host callback, questions are treated
   * as skipped instead of blocking.
   */
  function interactive() {
    return ["cli", "desktop", "sdk"].includes(Flag.MERAKCODE_CLIENT) && !Flag.MERAKCODE_NONINTERACTIVE
  }

  async function all(): Promise<Entry[]> {
    const custom = await customs()
    const builtin = [
      InvalidTool,
      ...(interactive() ? [QuestionTool] : []),
      BashTool,
      ReadTool,
      PdfParseTool,
      ExcelParseTool,
      ExcelWriteTool,
      DocxParseTool,
      GlobTool,
      GrepTool,
      EditTool,
      WriteTool,
      MultiEditTool,
      SubAgentTool,
      DelegateTool,
      WebFetchTool,
      TodoWriteTool,
      WebSearchTool,
      CodeSearchTool,
      SkillTool,
      RuleTool,
      CronCreateTool,
      CronListTool,
      CronDeleteTool,
      ...(Flag.MERAKCODE_EXPERIMENTAL_LSP_TOOL ? [LspTool] : []),
      ...(Flag.MERAKCODE_PLAN_MODE && interactive() ? [PlanExitTool, PlanEnterTool] : []),
      WorkflowRunTool,
      BashBackgroundTool,
    ]
    return [
      ...builtin.map((tool) => ({ tool, origin: "builtin" as const })),
      ...custom.map((tool) => ({ tool, origin: "custom" as const })),
    ]
  }

  export async function ids() {
    return all().then((x) => x.map(({ tool }) => tool.id))
  }

  export async function tools(
    model: {
      providerID: string
      modelID: string
    },
    agent?: Agent.Info,
  ): Promise<Initialized[]> {
    const tools = await all()
    // Filter by the agent's tool pool first, so tools that resolveTools() in runner.ts would drop anyway skip t.init()
    // (including Plugin.trigger("tool.definition")) and never build a description or parameters. "plugin" is the
    // virtual capability for dynamic tools and "invalid" is the fallback the runner always keeps, so neither can be
    // filtered like a static tool id. Only applies when an agent is passed: `GET /tool` in
    // server/routes/experimental.ts passes none and still returns the full catalog.
    const availablePool = agent?.profile?.availableTools ? new Set(agent.profile.availableTools) : undefined
    const dynamic = availablePool?.has("plugin") ? await dynamicIds() : undefined
    const result = await Promise.all(
      tools
        .filter(({ tool: t }) => {
          if (availablePool && t.id !== "invalid" && !availablePool.has(t.id) && !dynamic?.has(t.id)) return false

          // websearch and codesearch call the third-party Exa service, so they are only offered when enabled
          if (t.id === "codesearch" || t.id === "websearch") {
            return Flag.MERAKCODE_ENABLE_EXA
          }

          return true
        })
        .map(async ({ tool: t, origin }) => {
          using _ = log.time(t.id)
          const tool = await t.init({ agent })
          const output = {
            description: tool.description,
            parameters: tool.parameters,
          }
          await Plugin.trigger("tool.definition", { toolID: t.id }, output)
          return {
            id: t.id,
            // Static field, not from init(): search terms for deferred loading (see Tool.Info.triggerHint), scored by
            // ToolDiscovery via buildDeferredPlan and never put in the prompt.
            triggerHint: t.triggerHint,
            ...tool,
            description: output.description,
            parameters: output.parameters,
            origin,
          }
        }),
    )
    return result
  }
}
