import matter from "gray-matter"
import type { Text } from "../util/text"

/**
 * Rule file templates and frontmatter generation.
 *
 * A separate module for two reasons:
 * 1. New `.mdc` files get a valid `alwaysApply` from several entry points (settings page, the `file.create`
 *    endpoint); a single template keeps their skeletons from drifting apart.
 * 2. Generation uses gray-matter, the same library as `ConfigMarkdown.parse`, so the YAML written always reads back.
 *    The settings page therefore submits structured fields instead of assembling YAML.
 */
export namespace RuleTemplate {
  /**
   * Placeholder body for new rules. It **must not be empty**: `Rule.load` records an `.mdc` with frontmatter but no
   * body as a load failure and emits `session.error`, so an empty template would show an error right after creation.
   * The text is written into the user's own file, so it follows the UI language.
   */
  export const PLACEHOLDER_BODY: Text.Pair = {
    zh: "在此填写规则内容。",
    en: "Write the rule here.",
  }

  /** Placeholder for new instruction files such as AGENTS.md: plain markdown without frontmatter. */
  export const INSTRUCTION_PLACEHOLDER: Text.Pair = {
    zh: "# 项目指令\n\n在此填写希望模型始终遵守的项目约定。\n",
    en: "# Project Instructions\n\nWrite the project conventions the model should always follow.\n",
  }

  /** Structured rule fields, matching the RuleFrontmatter allowlist; `type` is derived by the engine, not an input. */
  export type Fields = {
    name?: string
    description?: string
    alwaysApply: boolean
    globs?: string[]
    exclude?: string[]
    agents?: string[]
    body: string
  }

  /**
   * Rule directory test with the same meaning as `NATIVE_CONTAINER` / `EXTERNAL_CONTAINER` / `DIR_NAMES` in `Rule`,
   * but based only on path segments, without the workspace, because the `file.create` hook must decide without a
   * rule snapshot. Subdirectories of rule directories count too (the loader scans `**\/*.mdc`).
   */
  const RULE_DIR_RE = /(?:^|\/)(?:\.merakcode\/rules?|\.cursor\/rules)\//i

  /** Whether the absolute path is an `.mdc` inside a rule directory; false for `.md` and for `.mdc` elsewhere. */
  export function isRuleFile(filepath: string) {
    const normalized = filepath.replace(/\\/g, "/")
    if (!/\.mdc$/i.test(normalized)) return false
    const slash = normalized.lastIndexOf("/")
    if (slash < 0) return false
    return RULE_DIR_RE.test(normalized.slice(0, slash + 1))
  }

  function clean(items?: string[]) {
    if (!items) return []
    const out: string[] = []
    for (const item of items) {
      const trimmed = item.trim()
      if (trimmed && !out.includes(trimmed)) out.push(trimmed)
    }
    return out
  }

  /**
   * Generates the full `.mdc` text from structured fields. `alwaysApply` always comes first (the required field
   * reads best on top), and empty fields are omitted: `globs: []` classifies the same as no globs and is just noise.
   */
  export function build(fields: Fields, lang: Text.Lang = "zh"): string {
    const data: Record<string, unknown> = { alwaysApply: fields.alwaysApply }
    const name = fields.name?.trim()
    if (name) data["name"] = name
    const description = fields.description?.trim()
    if (description) data["description"] = description
    const globs = clean(fields.globs)
    if (globs.length > 0) data["globs"] = globs
    const exclude = clean(fields.exclude)
    if (exclude.length > 0) data["exclude"] = exclude
    const agents = clean(fields.agents)
    if (agents.length > 0) data["agents"] = agents

    const body = fields.body.trim() || PLACEHOLDER_BODY[lang]
    return matter.stringify(`\n${body}\n`, data)
  }

  /** Default skeleton for a new `.mdc`: valid YAML frontmatter with `alwaysApply: true` and the placeholder body. */
  export function fresh(lang: Text.Lang = "zh") {
    return build({ alwaysApply: true, body: PLACEHOLDER_BODY[lang] }, lang)
  }
}
