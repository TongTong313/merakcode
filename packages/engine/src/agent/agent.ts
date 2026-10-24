import { Config } from "../config/config"
import z from "zod"
import { Provider } from "../provider/provider"
import { generateText, Output } from "ai"
import { Instance } from "../project/instance"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import PROMPT_CODE_SIMPLIFIER from "./prompt/code-simplifier.txt"
import PROMPT_WORKFLOW_SUBAGENT from "./prompt/workflow-subagent.txt"
import { PermissionNext } from "../permission/next"
import { PermissionPolicy } from "../permission/policy"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Plugin } from "../plugin"
import { MemoryAccess } from "../memory/access"

/**
 * Default tool pool of the main session (matches the runner's filtering and the settings page metadata).
 * `cron` in /safety/tools is a virtual tool cluster key (CLUSTER_KEYS in routes/safety.ts), not a tool id; the real
 * tools are CronCreate / CronList / CronDelete below.
 */
export const STANDARD_TOOL_POOL = [
  "bash",
  "read",
  "pdf_parse",
  "excel_parse",
  "excel_write",
  "docx_parse",
  "glob",
  "grep",
  "ls",
  "edit",
  "write",
  "multi_edit",
  "subagent",
  "delegate",
  "webfetch",
  "todowrite",
  "websearch",
  "codesearch",
  "skill",
  "rule",
  "workflow_run",
  "CronCreate",
  "CronList",
  "CronDelete",
  "question",
  "plan_enter",
  "plan_exit",
  "lsp",
  "mcp",
  "bash_background",
  // Virtual capability: exposes tools registered by local custom tools and plugins.
  "plugin",
] as const

/** Tool pool of the primary agents (build/plan) */
const PRIMARY_TOOL_POOL = STANDARD_TOOL_POOL

/**
 * Tools loaded on demand by default: large schemas, rarely used in a session.
 *
 * They stay out of the tools array (saving the token cost of the full description and parameters every turn) and
 * only get a one-line summary in the tool_search meta tool's description. When the model calls tool_search(name),
 * the tool is added with its full schema on the next turn.
 *
 * pdf/excel parsing and workflow orchestration have the heaviest schemas and are not needed every turn; the core
 * tools (read/write/edit/bash/glob/grep/todowrite) always stay loaded.
 * Overridden by config.agent.deferTools; an explicit [] disables deferred loading.
 */
export const DEFAULT_DEFERRED_TOOLS = [
  "pdf_parse",
  "excel_parse",
  "excel_write",
  "docx_parse",
  "workflow_run",
  "bash_background",
] as const

/**
 * Returns the deferred tools of an agent.
 *
 * - Without deferTools, falls back to DEFAULT_DEFERRED_TOOLS
 * - An explicit [] disables deferred loading (empty set, every tool loaded)
 * - Independent of disableTools: tools disableTools removed from availableTools are not listed (disable removes a
 *   tool, defer only delays it; disable applies first, so the two never overlap)
 *
 * Used by runner.resolveTools: tools in the set are left out of the tools array until activated, and summarized in
 * the tool_search description.
 */
export function computeDeferred(agent: Agent.Info): Set<string> {
  const configured = agent.profile?.deferTools ?? DEFAULT_DEFERRED_TOOLS
  const available = new Set(agent.profile?.availableTools ?? STANDARD_TOOL_POOL)
  return new Set(configured.filter((t) => available.has(t)))
}

const POOL_EXPLORE = STANDARD_TOOL_POOL.filter(
  (t) => !["write", "edit", "multi_edit", "bash_background", "plugin", "delegate"].includes(t),
)
const POOL_COMPACTION = ["read", "glob", "grep", "ls"] as const
const POOL_MEMORY_EXTRACTOR = ["read", "glob", "grep", "ls", "write", "edit", "multi_edit"] as const
// The session-memory agent only reads its notes and edits them
const POOL_SESSION_MEMORY = ["read", "edit"] as const

const POOL_WORKFLOW_SUBAGENT = STANDARD_TOOL_POOL.filter(
  (t) => !["subagent", "plan_enter", "plan_exit", "bash_background", "plugin", "delegate"].includes(t),
)
const EXPLORE_RESTRICTED = PermissionPolicy.deny(...PermissionPolicy.WRITE)

const WORKFLOW_SUBAGENT_RESTRICTED = PermissionNext.fromConfig({
  subagent: { "*": "deny" },
  workflow_run: { "*": "deny" },
  plan_enter: { "*": "deny" },
  plan_exit: { "*": "deny" },
})

export namespace Agent {
  export const Info = z
    .object({
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      // Hints that help the main agent decide when to call this subagent; only rendered into the SubAgentTool
      // description, not shown in the CLI or ACP
      triggerHints: z.array(z.string()).optional(),
      mode: z.enum(["subagent", "primary", "all"]),
      native: z.boolean().optional(),
      hidden: z.boolean().optional(),
      topP: z.number().optional(),
      temperature: z.number().optional(),
      color: z.string().optional(),
      permission: PermissionNext.Ruleset,
      profile: z
        .object({
          availableTools: z.array(z.string()),
          restrictedRules: PermissionNext.Ruleset,
          // Deferred tools stay out of the tools array until tool_search activates them for the next turn.
          // undefined uses DEFAULT_DEFERRED_TOOLS; [] disables deferred loading. See computeDeferred().
          deferTools: z.array(z.string()).optional(),
        })
        .optional(),
      model: z
        .object({
          modelID: z.string(),
          providerID: z.string(),
        })
        .optional(),
      variant: z.string().optional(),
      prompt: z.string().optional(),
      options: z.record(z.string(), z.any()),
      steps: z.number().int().positive().optional(),
    })
    .meta({
      ref: "Agent",
    })
  export type Info = z.infer<typeof Info>

  const state = Instance.state(async () => {
    const cfg = await Config.get()

    const user = PermissionNext.fromUserConfig(cfg.permission ?? {})
    // An empty string (a field left blank in the web settings) counts as unset, so Provider.parseModel("") does not
    // throw and the fallback applies
    const resolveConfiguredModel = (roleModel?: string, fallback?: string) => {
      const raw = [roleModel, fallback, cfg.model].find((v) => typeof v === "string" && v.trim().length > 0)
      return raw ? Provider.parseModel(raw) : undefined
    }

    const result: Record<string, Info> = {
      build: {
        id: "build",
        name: "build",
        description: "The default agent. Executes tools based on configured permissions.",
        options: {},
        permission: user,
        profile: {
          availableTools: [...PRIMARY_TOOL_POOL],
          restrictedRules: [],
        },
        mode: "primary",
        native: true,
      },
      general: {
        id: "general",
        name: "general",
        description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
        triggerHints: [
          "multi-step task that shouldn't pollute main context",
          "user asks to refactor multiple independent files (dispatch one per file)",
          "long-running research with many tool calls",
        ],
        permission: user,
        profile: {
          availableTools: [...STANDARD_TOOL_POOL],
          restrictedRules: [],
        },
        options: {},
        mode: "subagent",
        native: true,
      },
      explore: {
        id: "explore",
        name: "explore",
        permission: user,
        profile: {
          availableTools: [...POOL_EXPLORE],
          restrictedRules: EXPLORE_RESTRICTED,
        },
        description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). Put the desired search thoroughness in the subagent prompt, for example "Thoroughness: medium". Use "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions. Thoroughness is task guidance and must not be passed as the subagent mode; mode only accepts "fresh" or "fork".`,
        triggerHints: [
          `user asks "how does X work" / "where is Y handled" / "what's the codebase structure"`,
          "need to find files across multiple directories without knowing exact paths",
          "researching unfamiliar code before making changes (spawn multiple in parallel for independent areas)",
        ],
        prompt: PROMPT_EXPLORE,
        options: {},
        mode: "subagent",
        native: true,
      },
      simplifier: {
        id: "simplifier",
        name: "simplifier",
        description:
          "Simplifies and refines code for clarity, consistency, and maintainability while preserving exact functionality. Focuses on recently modified code unless instructed otherwise.",
        triggerHints: [
          "just finished writing a non-trivial feature",
          "user asks to clean up / simplify recently changed code",
          "reviewing your own recent edits before handing off",
        ],
        permission: PermissionNext.merge(
          user,
          PermissionNext.fromConfig({
            question: "deny",
          }),
        ),
        profile: {
          availableTools: STANDARD_TOOL_POOL.filter((t) => t !== "bash_background"),
          restrictedRules: PermissionNext.fromConfig({ question: "deny" }),
        },
        prompt: PROMPT_CODE_SIMPLIFIER,
        options: {},
        mode: "all",
        native: true,
      },
      compaction: {
        id: "compaction",
        name: "compaction",
        mode: "primary",
        native: true,
        hidden: true,
        prompt: PROMPT_COMPACTION,
        permission: PermissionNext.merge(
          user,
          PermissionNext.fromConfig({
            "*": "deny",
            read: "allow",
            grep: "allow",
            glob: "allow",
            ls: "allow",
          }),
        ),
        profile: {
          availableTools: [...POOL_COMPACTION],
          restrictedRules: PermissionNext.fromConfig({
            "*": "deny",
            read: "allow",
            grep: "allow",
            glob: "allow",
            ls: "allow",
          }),
        },
        options: {},
      },
      title: {
        id: "title",
        name: "title",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        temperature: 0.5,
        permission: PermissionNext.merge(
          user,
          PermissionNext.fromConfig({
            "*": "deny",
            read: "allow",
            grep: "allow",
            glob: "allow",
            ls: "allow",
          }),
        ),
        profile: {
          availableTools: [...POOL_COMPACTION],
          restrictedRules: PermissionNext.fromConfig({
            "*": "deny",
            read: "allow",
            grep: "allow",
            glob: "allow",
            ls: "allow",
          }),
        },
        prompt: PROMPT_TITLE,
      },
      summary: {
        id: "summary",
        name: "summary",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        permission: PermissionNext.merge(
          user,
          PermissionNext.fromConfig({
            "*": "deny",
            read: "allow",
            grep: "allow",
            glob: "allow",
            ls: "allow",
          }),
        ),
        profile: {
          availableTools: [...POOL_COMPACTION],
          restrictedRules: PermissionNext.fromConfig({
            "*": "deny",
            read: "allow",
            grep: "allow",
            glob: "allow",
            ls: "allow",
          }),
        },
        prompt: PROMPT_SUMMARY,
      },
      "memory-extractor": {
        id: "memory-extractor",
        name: "memory-extractor",
        description: "Internal post-turn memory extraction agent. Only reads context and updates memory files.",
        mode: "subagent",
        native: true,
        hidden: true,
        permission: MemoryAccess.extractorRules(),
        profile: {
          availableTools: [...POOL_MEMORY_EXTRACTOR],
          restrictedRules: MemoryAccess.extractorRules(),
        },
        options: {},
        model: resolveConfiguredModel(cfg.memory?.model, cfg.small_model ?? cfg.model),
      },
      "session-memory": {
        id: "session-memory",
        name: "session-memory",
        description: "Internal session memory note-taking agent. Only edits the session notes file.",
        mode: "subagent",
        native: true,
        hidden: true,
        // Read-only workspace access; only its session's summary.md is writable without approval
        // (isProjectFileBypass)
        permission: PermissionNext.fromConfig({ "*": "deny", read: "allow" }),
        profile: {
          availableTools: [...POOL_SESSION_MEMORY],
          restrictedRules: PermissionNext.fromConfig({ "*": "deny", read: "allow" }),
        },
        options: {},
        model: resolveConfiguredModel(cfg.memory?.model, cfg.small_model ?? cfg.model),
      },
      "memory-dreamer": {
        id: "memory-dreamer",
        name: "memory-dreamer",
        description:
          "Internal memory consolidation agent. Reviews and consolidates memory files (merge/dedup/prune index).",
        mode: "subagent",
        native: true,
        hidden: true,
        // Consolidation and extraction share one sandbox (read/grep/glob/ls plus write/edit in the memory directory);
        // bash is denied, exploration uses grep/glob/ls/read
        permission: MemoryAccess.extractorRules(),
        profile: {
          availableTools: [...POOL_MEMORY_EXTRACTOR],
          restrictedRules: MemoryAccess.extractorRules(),
        },
        options: {},
        model: resolveConfiguredModel(cfg.memory?.model, cfg.small_model ?? cfg.model),
      },
      "workflow-subagent": {
        id: "workflow-subagent",
        name: "workflow-subagent",
        description: "Dynamic workflow internal worker. Only called by workflow_run.",
        mode: "subagent",
        native: true,
        hidden: true,
        prompt: PROMPT_WORKFLOW_SUBAGENT,
        permission: user,
        profile: {
          availableTools: [...POOL_WORKFLOW_SUBAGENT],
          restrictedRules: WORKFLOW_SUBAGENT_RESTRICTED,
        },
        options: {},
      },
    }

    for (const [key, value] of Object.entries(cfg.agent ?? {})) {
      if (value.disable) {
        delete result[key]
        continue
      }
      let item = result[key]
      if (!item)
        item = result[key] = {
          id: key,
          name: key,
          mode: "all",
          permission: user,
          profile: {
            availableTools: [...STANDARD_TOOL_POOL],
            restrictedRules: [],
          },
          options: {},
          native: false,
        }
      if (value.model) item.model = Provider.parseModel(value.model)
      item.variant = value.variant ?? item.variant
      item.prompt = value.prompt ?? item.prompt
      item.description = value.description ?? item.description
      item.temperature = value.temperature ?? item.temperature
      item.topP = value.top_p ?? item.topP
      item.mode = value.mode ?? item.mode
      item.color = value.color ?? item.color
      item.hidden = value.hidden ?? item.hidden
      item.name = value.name ?? item.name
      item.steps = value.steps ?? item.steps
      item.options = mergeDeep(item.options, value.options ?? {})
      // Internal protocol keys in the user's agent.permission are filtered out as well
      const agentUserRules = PermissionNext.fromUserConfig(value.permission ?? {})
      item.permission = PermissionNext.merge(item.permission, agentUserRules)

      // disableTools only removes tools from the existing pool and never grants unregistered ones, so a misspelled id
      // does nothing instead of opening a permission. It lets users or organizations drop niche tools they never use
      // (PDF/Excel/workflow/cron, ...) to save their per-turn token cost.
      if (value.disableTools?.length && item.profile) {
        const disabled = new Set(value.disableTools)
        item.profile = {
          ...item.profile,
          availableTools: item.profile.availableTools.filter((t) => !disabled.has(t)),
        }
      }

      // deferTools is independent of disableTools: disable removes a tool from the pool, defer keeps it in the pool
      // but out of the tools array until tool_search activates it for the next turn.
      // When undefined the field is not set and computeDeferred() falls back to DEFAULT_DEFERRED_TOOLS; an explicit
      // [] disables deferred loading. Only stored in the profile; availableTools is unchanged.
      if (value.deferTools !== undefined && item.profile) {
        item.profile = { ...item.profile, deferTools: value.deferTools }
      }
    }

    return result
  })

  export async function get(id: string) {
    const agents = await state()
    return agents[id]
  }

  export async function list() {
    const cfg = await Config.get()
    return pipe(
      await state(),
      values(),
      sortBy([(x) => (cfg.default_agent ? x.id === cfg.default_agent : x.id === "build"), "desc"]),
    )
  }

  export async function defaultAgent(): Promise<string> {
    const cfg = await Config.get()
    const agents = await state()

    if (cfg.default_agent) {
      const agent = agents[cfg.default_agent]
      if (!agent) throw new Error(`default agent "${cfg.default_agent}" not found`)
      if (agent.mode === "subagent") throw new Error(`default agent "${cfg.default_agent}" is a subagent`)
      if (agent.hidden === true) throw new Error(`default agent "${cfg.default_agent}" is hidden`)
      return agent.id
    }

    const primaryVisible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
    if (!primaryVisible) throw new Error("no primary visible agent found")
    return primaryVisible.id
  }

  /**
   * Clears the derived agent cache of the current Instance.
   * Used after a tool permission toggle in the safety panel (project scope), so Agent.permission reflects the latest
   * config right away. Only clears the cache; the next Agent.get(...) derives it again from Config.get().
   */
  export function invalidate() {
    state.invalidate()
  }

  /**
   * Clears the derived agent cache of every Instance.
   * Used after a tool permission toggle in the safety panel (global scope), so every open Instance picks it up.
   */
  export function invalidateAll() {
    state.invalidateAll()
  }

  export async function generate(input: { description: string; model?: { providerID: string; modelID: string } }) {
    const defaultModel = input.model ?? (await Provider.defaultModel())
    const model = await Provider.getModel(defaultModel.providerID, defaultModel.modelID)
    const language = await Provider.getLanguage(model)

    const system = [PROMPT_GENERATE]
    await Plugin.trigger("experimental.chat.system.transform", { model }, { system })
    const existing = await list()

    const params = {
      temperature: 0.3,
      instructions: system.map((content) => ({ role: "system" as const, content })),
      prompt: `Create an agent configuration based on this request: "${input.description}".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
      model: language,
      output: Output.object({
        schema: z.object({
          identifier: z.string(),
          whenToUse: z.string(),
          systemPrompt: z.string(),
        }),
      }),
    }

    const result = await generateText(params)
    return result.output
  }
}
