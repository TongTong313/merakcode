import { JsonError } from "../../infra/config/error"
import { mergeDeep } from "remeda"
import { applyEdits, modify, parse as parseJsonc, type ParseError as JsoncParseError } from "jsonc-parser"
import { ConfigEdit } from "../../infra/config/edit"
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

export namespace PermissionCompatibility {
  function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
  }
  /**
   * Deprecated config fields. load() first migrates them to their equivalents, then strips them with a warning.
   *
   * A field with an equivalent is migrated; only fields without one, or internal protocol keys, are removed. Old
   * configs must neither fail the strict schema (the client would not open) nor silently lose tool settings.
   *
   * - permission.list: the tool was renamed to ls; migrates to permission.ls.
   * - permission.task: the tool was renamed to subagent; migrates to permission.subagent.
   * - permission.todoread: the tool was removed; deleted (the rule would never match).
   * - permission.todowrite/doom_loop/plan_enter/plan_exit: internal agent protocol (INTERNAL_PERMISSION_KEYS); deleted.
   *
   * permission.question is not listed: custom agents may still configure it; builtin agents use restrictedRules.
   * The removed safety section (safety.bash.* / safety.allowExternalDirectory) is not listed either: it is gone from
   * the Info schema, so it is reported as an unrecognized top-level key and never read or written back.
   */
  export const DEPRECATED_SAFETY_FIELDS = [
    "permission.list",
    "permission.task",
    "permission.todoread",
    "permission.todowrite",
    "permission.doom_loop",
    "permission.plan_enter",
    "permission.plan_exit",
  ]

  /** Renamed permission keys, old -> new (migrated only when the new key is absent) */
  const PERMISSION_KEY_RENAMES: Record<string, string> = {
    list: "ls",
    task: "subagent",
  }

  /** Migrates list -> ls and task -> subagent in one permission object; an existing new key wins */
  function migratePermissionKeys(permission: Record<string, unknown>): Record<string, unknown> {
    const next: Record<string, unknown> = { ...permission }
    for (const [oldKey, newKey] of Object.entries(PERMISSION_KEY_RENAMES)) {
      if (next[oldKey] !== undefined && next[newKey] === undefined) {
        next[newKey] = next[oldKey]
      }
    }
    return next
  }

  export function detectDeprecated(obj: unknown, fields: string[]): string[] {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return []
    const found: string[] = []
    for (const field of fields) {
      const parts = field.split(".")
      let current: any = obj
      let exists = true
      for (const part of parts) {
        if (!isRecord(current) || !(part in current)) {
          exists = false
          break
        }
        current = current[part]
      }
      if (exists) found.push(field)
    }
    return found
  }

  function stripDeprecated(obj: any, fields: string[]): any {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj
    const result = { ...obj }
    for (const field of fields) {
      const parts = field.split(".")
      if (parts.length === 1) {
        delete result[parts[0]]
      } else {
        let current = result
        for (let i = 0; i < parts.length - 1; i++) {
          if (!current[parts[i]]) break
          current = current[parts[i]]
        }
        if (current && typeof current === "object") {
          delete current[parts[parts.length - 1]]
        }
      }
    }
    return result
  }

  /**
   * Compatibility normalization before a config is read or written back:
   * - permission: migrate list -> ls and task -> subagent;
   * - agent.<name>.permission: the same migration and stripping for nested agent config;
   * - finally stripDeprecated removes deprecated fields (internal protocol keys, removed tools, ...).
   */
  export function normalizeDeprecatedForWrite(obj: unknown): unknown {
    if (!isRecord(obj)) return obj

    const result: Record<string, any> = { ...obj }
    if (isRecord(obj.permission)) {
      result.permission = migratePermissionKeys(obj.permission)
    }
    if (isRecord(obj.tools)) {
      const permission = isRecord(result.permission) ? { ...result.permission } : {}
      for (const [tool, enabled] of Object.entries(obj.tools)) {
        const action = enabled ? "allow" : "deny"
        if (tool === "write" || tool === "edit" || tool === "patch" || tool === "multiedit") {
          permission.edit ??= action
          continue
        }
        if (tool === "list") {
          permission.ls ??= action
          continue
        }
        if (tool === "task") {
          permission.subagent ??= action
          continue
        }
        permission[tool] ??= action
      }
      result.permission = permission
    }
    if (isRecord(obj.agent)) {
      const agentNext: Record<string, any> = {}
      for (const [name, raw] of Object.entries(obj.agent)) {
        if (!isRecord(raw)) {
          agentNext[name] = raw
          continue
        }
        const next: Record<string, any> = { ...raw }
        if (isRecord(raw.permission)) {
          next.permission = migratePermissionKeys(raw.permission)
        }
        // Remove deprecated permission keys from nested agents, matching permission.* in DEPRECATED_SAFETY_FIELDS.
        if (isRecord(next.permission)) {
          for (const field of DEPRECATED_SAFETY_FIELDS) {
            const [scope, key] = field.split(".")
            if (scope !== "permission" || !key) continue
            delete (next.permission as Record<string, unknown>)[key]
          }
        }
        agentNext[name] = next
      }
      result.agent = agentNext
    }

    return stripDeprecated(result, DEPRECATED_SAFETY_FIELDS)
  }

  /** Applies the same migration as normalizeDeprecatedForWrite to JSONC text, keeping comments and formatting */
  export function normalizeDeprecatedJsoncForWrite(input: string): string {
    const errors: JsoncParseError[] = []
    const data = parseJsonc(input, errors, { allowTrailingComma: true })
    if (errors.length || !isRecord(data)) return input

    let result = input
    const permission = data.permission
    if (isRecord(permission)) {
      for (const [oldKey, newKey] of Object.entries(PERMISSION_KEY_RENAMES)) {
        if (permission[oldKey] !== undefined && permission[newKey] === undefined) {
          result = ConfigEdit.set(result, ["permission", newKey], permission[oldKey])
        }
      }
    }

    if (isRecord(data.agent)) {
      for (const [agentName, raw] of Object.entries(data.agent)) {
        if (!isRecord(raw) || !isRecord(raw.permission)) continue
        const agentPermission = raw.permission
        for (const [oldKey, newKey] of Object.entries(PERMISSION_KEY_RENAMES)) {
          if (agentPermission[oldKey] !== undefined && agentPermission[newKey] === undefined) {
            const edits = modify(result, ["agent", agentName, "permission", newKey], agentPermission[oldKey], {
              formattingOptions: { insertSpaces: true, tabSize: 2 },
            })
            result = applyEdits(result, edits)
          }
        }
      }
    }

    // Top-level and permission.* fields
    result = detectDeprecated(data, DEPRECATED_SAFETY_FIELDS).reduce((text, field) => {
      const edits = modify(text, field.split("."), undefined, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      })
      return applyEdits(text, edits)
    }, result)

    // Deprecated keys in nested agent.<name>.permission
    if (isRecord(data.agent)) {
      for (const [agentName, raw] of Object.entries(data.agent)) {
        if (!isRecord(raw) || !isRecord(raw.permission)) continue
        for (const field of DEPRECATED_SAFETY_FIELDS) {
          const [scope, key] = field.split(".")
          if (scope !== "permission" || !key) continue
          if ((raw.permission as Record<string, unknown>)[key] === undefined) continue
          const edits = modify(result, ["agent", agentName, "permission", key], undefined, {
            formattingOptions: { insertSpaces: true, tabSize: 2 },
          })
          result = applyEdits(result, edits)
        }
      }
    }

    return result
  }

  export function toolsPermission(
    tools: Record<string, boolean> | undefined,
    permission: PermissionConfig.Permission | undefined,
  ) {
    if (!tools) return permission
    const perms: Record<string, PermissionConfig.PermissionAction> = {}
    for (const [tool, enabled] of Object.entries(tools)) {
      const action: PermissionConfig.PermissionAction = enabled ? "allow" : "deny"
      if (tool === "write" || tool === "edit" || tool === "patch" || tool === "multiedit") {
        perms.edit = action
        continue
      }
      if (tool === "list") {
        perms.ls = action
        continue
      }
      if (tool === "task") {
        perms.subagent = action
        continue
      }
      perms[tool] = action
    }
    return mergeDeep(perms, permission ?? {})
  }

  export function editRule(
    text: string,
    input: { permission: string; pattern: string; action?: PermissionConfig.PermissionAction },
    filepath: string,
    invalidMessage: string,
  ) {
    const errors: JsoncParseError[] = []
    const data = parseJsonc(text, errors, { allowTrailingComma: true })
    if (errors.length || !isRecord(data))
      throw new JsonError({
        path: filepath,
        message: invalidMessage,
      })
    const permission = isRecord(data.permission) ? data.permission : {}
    const existing = permission[input.permission]
    const rules: Record<string, unknown> =
      typeof existing === "string" ? { "*": existing } : isRecord(existing) ? { ...existing } : {}
    if (input.action) rules[input.pattern] = input.action
    else delete rules[input.pattern]
    const empty = Object.keys(rules).length === 0
    const remaining = Object.keys(permission).filter((key) => key !== input.permission).length
    const target = empty && remaining === 0 ? ["permission"] : ["permission", input.permission]
    const edits = modify(text, target, empty ? undefined : rules, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    })
    return applyEdits(text, edits)
  }
}
