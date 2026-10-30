import z from "zod"

export namespace PermissionConfig {
  export const PermissionAction = z.enum(["ask", "allow", "deny"]).meta({
    ref: "PermissionActionConfig",
  })
  export type PermissionAction = z.infer<typeof PermissionAction>

  export const PermissionObject = z.record(z.string(), PermissionAction).meta({
    ref: "PermissionObjectConfig",
  })
  export type PermissionObject = z.infer<typeof PermissionObject>

  export const PermissionRule = z.union([PermissionAction, PermissionObject]).meta({
    ref: "PermissionRuleConfig",
  })
  export type PermissionRule = z.infer<typeof PermissionRule>

  // Capture original key order before zod reorders, then rebuild in original order
  const permissionPreprocess = (val: unknown) => {
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      return { __originalKeys: Object.keys(val), ...val }
    }
    return val
  }

  const permissionTransform = (x: unknown): Record<string, PermissionRule> => {
    if (typeof x === "string") return { "*": x as PermissionAction }
    const obj = x as { __originalKeys?: string[] } & Record<string, unknown>
    const { __originalKeys, ...rest } = obj
    if (!__originalKeys) return rest as Record<string, PermissionRule>
    const result: Record<string, PermissionRule> = {}
    for (const key of __originalKeys) {
      if (key in rest) result[key] = rest[key] as PermissionRule
    }
    return result
  }

  // Permission rules. Keys match the PermissionPolicy categories; values are allow / ask / deny, or a
  // "pattern -> action" map. Files match by absolute path, commands by the whole command text ("npm test *" matches
  // commands starting with npm test), network by domain.
  // Not exposed: todowrite / plan_* / question / doom_loop are internal agent protocol, locked by
  // PermissionNext.INTERNAL_PERMISSION_KEYS; values written for them through the catchall are ignored.
  export const Permission = z
    .preprocess(
      permissionPreprocess,
      z
        .object({
          __originalKeys: z.string().array().optional(),
          read: PermissionRule.optional().describe("Read files inside the workspace"),
          external_read: PermissionRule.optional().describe("Read files outside the workspace"),
          sensitive_read: PermissionRule.optional().describe("Read secrets: .env, keys, certificates, credentials"),
          edit: PermissionRule.optional().describe("Write files inside the workspace"),
          protected_write: PermissionRule.optional().describe("Write .git and dotfiles inside the workspace"),
          config_write: PermissionRule.optional().describe(
            "Write MerakCode's config files (merakcode.json, merakcode.jsonc), global or a project's",
          ),
          external_write: PermissionRule.optional().describe("Write files outside the workspace"),
          bash_readonly: PermissionRule.optional().describe("Run read-only commands (ls, git status, ...)"),
          bash: PermissionRule.optional().describe("Run other commands"),
          bash_delete: PermissionRule.optional().describe("Run commands that delete files (rm, git clean, ...)"),
          bash_risky: PermissionRule.optional().describe("Run risky commands (sudo, git push, npm publish, ...)"),
          bash_forbidden: PermissionRule.optional().describe(
            "Run commands that wipe the system or home folder, format disks or write raw disks (denied unless allowed here)",
          ),
          bash_unsandboxed: PermissionRule.optional().describe(
            "Run a command that may change things while the sandbox is not ready",
          ),
          sandbox: PermissionRule.optional().describe("Run a command with extra sandbox permissions"),
          network: PermissionRule.optional().describe("Connect to a domain"),
          subagent: PermissionRule.optional().describe("Start a subagent"),
          workflow_run: PermissionRule.optional().describe("Start a workflow"),
          cron: PermissionRule.optional(),
          mcp: PermissionRule.optional().describe("Call an MCP tool (pattern: server/tool)"),
          glob: PermissionRule.optional(),
          grep: PermissionRule.optional(),
          ls: PermissionRule.optional(),
          lsp: PermissionRule.optional(),
          skill: PermissionRule.optional(),
        })
        .catchall(PermissionRule)
        .or(PermissionAction),
    )
    .transform(permissionTransform)
    // The transform yields "category -> rule" in the original order; declaring it gives the API docs and the SDK
    // return type a shape.
    .pipe(z.record(z.string(), PermissionRule))
    .meta({
      ref: "PermissionConfig",
    })
  export type Permission = z.infer<typeof Permission>

  export const Sandbox = z.object({
    mode: z
      .enum(["preferred", "required", "off"])
      .optional()
      .describe(
        "preferred (default): use the sandbox when it is ready; until then commands that change things ask first, even in auto mode. required: refuse to run commands while the sandbox is not ready. off: never use the sandbox.",
      ),
    read: z
      .object({
        deny: z
          .array(z.string())
          .optional()
          .describe(
            "Extra folders commands cannot read, besides ~/.ssh, ~/.aws and the other credential folders. ~/ means your home folder.",
          ),
      })
      .optional(),
    write: z
      .object({
        allow: z
          .array(z.string())
          .optional()
          .describe(
            "Extra folders commands can always write, besides the workspace, the temp folder and package caches.",
          ),
      })
      .optional(),
    network: z
      .object({
        allowLocalPorts: z
          .array(z.number().int().min(1).max(65535))
          .optional()
          .describe(
            "Linux only: local ports commands may connect to directly, for example a database at 127.0.0.1:5432.",
          ),
      })
      .optional(),
    redactSecrets: z
      .boolean()
      .optional()
      .describe("Hide API keys, tokens and passwords in command output before the model sees it. Defaults to true."),
  })
}

export namespace PermissionSettings {
  const Permission = PermissionConfig.Permission
  export const fields = {
    permission: Permission.optional(),
    sandbox: PermissionConfig.Sandbox.optional().describe("Sandbox for the commands the agent runs."),
  }
}
