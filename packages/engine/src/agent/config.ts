import z from "zod"
import { PermissionConfig } from "./permission/config"
import { ModelId } from "./model/config"

export namespace AgentConfig {
  const Permission = PermissionConfig.Permission
  type Permission = PermissionConfig.Permission

  const AgentFields = z
    .object({
      model: ModelId.optional(),
      variant: z
        .string()
        .optional()
        .describe("Default model variant for this agent (applies only when using the agent's configured model)."),
      temperature: z.number().optional(),
      top_p: z.number().optional(),
      prompt: z.string().optional(),
      tools: z.record(z.string(), z.boolean()).optional().describe("@deprecated Use 'permission' field instead"),
      disable: z.boolean().optional(),
      description: z.string().optional().describe("Description of when to use the agent"),
      mode: z.enum(["subagent", "primary", "all"]).optional(),
      hidden: z
        .boolean()
        .optional()
        .describe("Hide this subagent from the @ autocomplete menu (default: false, only applies to mode: subagent)"),
      options: z.record(z.string(), z.any()).optional(),
      color: z
        .union([
          z.string().regex(/^#[0-9a-fA-F]{6}$/, "Invalid hex color format"),
          z.enum(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
        ])
        .optional()
        .describe("Hex color code (e.g., #FF5733) or theme color (e.g., primary)"),
      steps: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of agentic iterations before forcing text-only response"),
      maxSteps: z.number().int().positive().optional().describe("@deprecated Use 'steps' field instead."),
      permission: Permission.optional(),
      disableTools: z
        .array(z.string())
        .optional()
        .describe(
          "Tool ids to remove from this agent's available-tools pool (e.g. pdf_parse, workflow_run) — reduces per-turn tool-schema token cost for tools this agent will never use. Only ever narrows the existing pool; unknown ids are ignored.",
        ),
      deferTools: z
        .array(z.string())
        .optional()
        .describe(
          "Tool ids to defer-load: kept out of the tools array (only a one-line summary in the tool_search description) until the model activates one via tool_search, after which it is available with full parameters on the next turn. " +
            "Defaults to [pdf_parse, excel_parse, excel_write, workflow_run]. Pass an empty array to disable deferral entirely (load all tools eagerly). Only applies to tools still in the pool (respecting disableTools).",
        ),
    })
    .catchall(z.any())

  export const Agent = AgentFields.transform((agent): z.input<typeof AgentFields> => {
    const knownKeys = new Set([
      "name",
      "model",
      "variant",
      "prompt",
      "description",
      "temperature",
      "top_p",
      "mode",
      "hidden",
      "color",
      "steps",
      "maxSteps",
      "options",
      "permission",
      "disable",
      "tools",
      "disableTools",
      "deferTools",
    ])

    // Extract unknown properties into options
    const options: Record<string, unknown> = { ...agent.options }
    for (const [key, value] of Object.entries(agent)) {
      if (!knownKeys.has(key)) options[key] = value
    }

    // Backward compatibility: legacy agent.tools maps to permission.
    // write / edit / patch / multiedit all become edit (writing files inside the workspace).
    // list was renamed to ls and task to subagent; both migrate so old configs keep applying.
    // Internal protocol keys (plan_enter/plan_exit/doom_loop/todowrite) are skipped, in sync with
    // PermissionNext.INTERNAL_PERMISSION_KEYS. Do not import the permission module: it would create an import cycle.
    const LEGACY_AGENT_TOOLS_PERMISSION_SKIP = new Set(["plan_enter", "plan_exit", "doom_loop", "todowrite"])
    const permission: Permission = {}
    for (const [tool, enabled] of Object.entries(agent.tools ?? {})) {
      if (LEGACY_AGENT_TOOLS_PERMISSION_SKIP.has(tool)) continue
      const action = enabled ? "allow" : "deny"
      if (tool === "write" || tool === "edit" || tool === "patch" || tool === "multiedit") {
        permission.edit = action
      } else if (tool === "list") {
        permission.ls = action
      } else if (tool === "task") {
        permission.subagent = action
      } else {
        permission[tool] = action
      }
    }
    Object.assign(permission, agent.permission)

    // Convert legacy maxSteps to steps
    const steps = agent.steps ?? agent.maxSteps

    return { ...agent, options, permission, steps }
  })
    // The normalized result is still an agent config (validating it again is idempotent); declaring it gives the API
    // docs and the SDK return type a shape.
    .pipe(AgentFields)
    .meta({
      ref: "AgentConfig",
    })
  export type Agent = z.infer<typeof Agent>
}

export namespace AgentSettings {
  const Agent = AgentConfig.Agent
  export const fields = {
    default_agent: z
      .string()
      .optional()
      .describe(
        "Default agent to use when none is specified. Must be a primary agent. Falls back to 'build' if not set or if the specified agent is invalid.",
      ),
    mode: z
      .object({
        build: Agent.optional(),
        plan: Agent.optional(),
      })
      .catchall(Agent)
      .optional()
      .describe("@deprecated Use `agent` field instead."),
    agent: z
      .object({
        // primary
        plan: Agent.optional(),
        build: Agent.optional(),
        // subagent
        general: Agent.optional(),
        explore: Agent.optional(),
        // specialized
        title: Agent.optional(),
        summary: Agent.optional(),
        compaction: Agent.optional(),
        "memory-extractor": Agent.optional(),
        simplifier: Agent.optional(),
      })
      .catchall(Agent)
      .optional()
      .describe("Agent configuration"),
  }
}
