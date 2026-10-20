import { z } from "zod"
import { Rule } from "./rule"

/**
 * Read/write contract for rule management in the settings page.
 *
 * Shaped like `McpManagementContract`: a full snapshot plus a discriminated union of commands, each returning a new
 * snapshot. The settings page keeps no incremental state, so the list cannot drift from the disk after an edit.
 *
 * `Rule.Info` holds only the **active** rules used for injection; broken rules, shadowed `.cursor` rules and
 * instruction files such as AGENTS.md are not in it. The settings page must list those too (it is where users fix
 * broken rules), hence separate management entry types.
 */
export namespace RuleManageContract {
  /**
   * Structured rule fields. The settings form submits these and the engine generates the frontmatter, so the
   * frontend never assembles YAML and cannot write a broken rule. `type` is not included: it is derived from
   * alwaysApply / globs / description.
   */
  export const Fields = z
    .object({
      name: z.string().optional(),
      description: z.string().optional(),
      alwaysApply: z.boolean(),
      globs: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
      agents: z.array(z.string()).optional(),
      body: z.string(),
    })
    .meta({ ref: "RuleFields" })
  export type Fields = z.infer<typeof Fields>

  /** One global user rule. It has no backing file and is addressed by array index. */
  export const UserRule = z
    .object({
      index: z.number().int().nonnegative(),
      text: z.string(),
      bytes: z.number().int().nonnegative(),
      /** Over the per-rule limit, so it is truncated when injected */
      truncated: z.boolean(),
    })
    .meta({ ref: "RuleUserEntry" })
  export type UserRule = z.infer<typeof UserRule>

  /**
   * Where an entry comes from:
   * - native   `.merakcode/rule(s)/**\/*.mdc`
   * - external `.cursor/rules/**\/*.mdc` (read for compatibility; the whole directory is shadowed when native rules
   *   exist in the same directory)
   * - instruction  instruction files such as AGENTS.md / CLAUDE.md (no frontmatter)
   */
  export const FileKind = z.enum(["native", "external", "instruction"])
  export type FileKind = z.infer<typeof FileKind>

  export const File = z
    .object({
      filepath: z.string(),
      /** Short display path: relative to the workspace folder for project files, `~/`-prefixed for global files */
      label: z.string(),
      kind: FileKind,
      scope: Rule.Scope,
      /** Display name: frontmatter.name or the relative path for `.mdc`, the file name for instruction files */
      name: z.string(),
      description: z.string(),
      /** How the rule applies; empty for unparsable rules and instruction files */
      type: Rule.Type.optional(),
      alwaysApply: z.boolean().optional(),
      globs: z.array(z.string()),
      exclude: z.array(z.string()),
      agents: z.array(z.string()).optional(),
      /** Raw file text (frontmatter plus body); a truncated preview when over the view limit, see clipped */
      content: z.string(),
      /**
       * Body without frontmatter, used to fill the settings form. The engine provides it instead of letting the
       * frontend strip YAML, because a different stripping would make the form show something other than what the
       * model reads. Equals content for instruction files, which have no frontmatter.
       */
      body: z.string(),
      bytes: z.number().int().nonnegative(),
      /** Over the per-rule injection limit, so the model sees a truncated version */
      truncated: z.boolean(),
      /** Over the view limit: content is only a preview and cannot be saved from the settings page */
      clipped: z.boolean(),
      /** Whether the rule is actually in effect (false for broken rules and shadowed cursor rules) */
      active: z.boolean(),
      /** Why the rule is not in effect (parse failure reason or shadowing note) */
      problem: z.string().optional(),
      /** Whether form mode is available (an `.mdc` whose frontmatter parses) */
      structured: z.boolean(),
      /**
       * Whether the settings page may save it. Global instruction files (such as `~/.config/merakcode/AGENTS.md`)
       * affect all projects, so a project settings page only previews them.
       */
      editable: z.boolean(),
      /** Whether the settings page may delete it. Global instruction files are read-only */
      removable: z.boolean(),
    })
    .meta({ ref: "RuleFileEntry" })
  export type File = z.infer<typeof File>

  /**
   * A location for new files. The frontend only sends back the id and the engine owns the path, which makes the
   * targets a write allowlist.
   */
  export const Target = z
    .object({
      id: z.string(),
      kind: FileKind,
      directory: z.string(),
      label: z.string(),
      /** Rules here are shadowed by native rules in the same directory (only external can be true) */
      shadowed: z.boolean(),
      /** An active instruction file already exists here and would shadow a new one (instruction only) */
      occupied: z.string().optional(),
    })
    .meta({ ref: "RuleTarget" })
  export type Target = z.infer<typeof Target>

  export const Shadowed = z
    .object({
      directory: z.string(),
      by: z.number().int().nonnegative(),
    })
    .meta({ ref: "RuleShadowed" })

  export const Snapshot = z
    .object({
      user: z.array(UserRule),
      files: z.array(File),
      shadowed: z.array(Shadowed),
      targets: z.array(Target),
      /** When a flag disables rules, the list stays manageable but the page must say the rules are not in effect */
      disabled: z.object({ rules: z.boolean(), cursorRules: z.boolean() }),
    })
    .meta({ ref: "RuleSnapshot" })
  export type Snapshot = z.infer<typeof Snapshot>

  export const Command = z.discriminatedUnion("type", [
    z.object({ type: z.literal("user_add"), text: z.string().trim().min(1) }),
    z.object({
      type: z.literal("user_update"),
      index: z.number().int().nonnegative(),
      text: z.string().trim().min(1),
    }),
    z.object({ type: z.literal("user_remove"), index: z.number().int().nonnegative() }),
    z.object({
      type: z.literal("file_create"),
      targetId: z.string().min(1),
      filename: z.string().trim().min(1),
      /** Defaults to the skeleton (`alwaysApply: true` plus placeholder body); ignored for instruction targets */
      fields: Fields.optional(),
    }),
    /** Raw write, used by source mode and instruction files */
    z.object({ type: z.literal("file_write"), filepath: z.string().min(1), content: z.string() }),
    /** Structured write, `.mdc` only; the engine generates the frontmatter */
    z.object({ type: z.literal("file_write_fields"), filepath: z.string().min(1), fields: Fields }),
    z.object({ type: z.literal("file_delete"), filepath: z.string().min(1) }),
  ])
  export type Command = z.infer<typeof Command>
  export type CommandInput = z.input<typeof Command>

  export const ErrorInfo = z
    .object({
      code: z.enum([
        "not_found",
        "already_exists",
        "invalid_path",
        "invalid_filename",
        "not_editable",
        "not_removable",
        "too_large",
        "write_failed",
      ]),
      message: z.string(),
    })
    .meta({ ref: "RuleManageError" })
  export type ErrorInfo = z.infer<typeof ErrorInfo>

  export const Result = z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), snapshot: Snapshot }),
    z.object({ ok: z.literal(false), error: ErrorInfo, snapshot: Snapshot.optional() }),
  ])
  export type Result = z.infer<typeof Result>
}
