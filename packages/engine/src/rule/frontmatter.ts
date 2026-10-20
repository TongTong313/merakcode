import type { Text } from "../util/text"

/**
 * Parsing and normalization of rule file frontmatter.
 *
 * `.cursor/rules/*.mdc` and native `.merakcode/rules/*.mdc` share field semantics but differ in syntax (see
 * parsePatterns). A single parser keeps the same frontmatter behaving the same way for both sources.
 *
 * Allowed `.mdc` frontmatter fields: alwaysApply (required, true/false only) and the optional description / globs /
 * name / exclude / agents. Other fields are ignored; aliases are not accepted.
 */
export namespace RuleFrontmatter {
  /**
   * How a rule applies, derived from three frontmatter fields rather than set directly:
   * - always: in the system prompt every turn
   * - auto: injected when a file matching globs is touched
   * - agent-requested: the model sees a summary and decides whether to load the body
   * - manual: attached only when the user @-mentions the rule
   */
  export type Type = "always" | "auto" | "agent-requested" | "manual"

  export type Parsed = {
    name?: string
    description: string
    globs: string[]
    exclude: string[]
    agents?: string[]
    alwaysApply: boolean
    type: Type
  }

  /** Failure reasons appear in settings, /context and errors, so both languages are given and the caller picks one */
  export type ParseResult = { ok: true; value: Parsed } | { ok: false; reason: Text.Pair }

  export const Reason = {
    missingAlwaysApply: {
      zh: "frontmatter 缺少 alwaysApply 字段",
      en: "The frontmatter is missing the alwaysApply field",
    },
    invalidAlwaysApply: { zh: "alwaysApply 只能是 true 或 false", en: "alwaysApply must be true or false" },
    descriptionType: { zh: "description 必须是字符串", en: "description must be a string" },
    globsType: { zh: "globs 必须是字符串或字符串数组", en: "globs must be a string or an array of strings" },
    nameType: { zh: "name 必须是字符串", en: "name must be a string" },
    excludeType: { zh: "exclude 必须是字符串或字符串数组", en: "exclude must be a string or an array of strings" },
    agentsType: { zh: "agents 必须是字符串或字符串数组", en: "agents must be a string or an array of strings" },
  } satisfies Record<string, Text.Pair>

  /**
   * Parses a glob list. Cursor `.mdc` files write globs as a comma separated **string** (as in this repo's
   * `.cursor/rules/packages-feature-unit-tests.mdc`), while this product writes YAML arrays. Both must be accepted:
   * with arrays only, imported .cursor rules would silently do nothing, without any error.
   */
  export function parsePatterns(value: unknown): string[] {
    const out: string[] = []
    const push = (raw: string) => {
      // Commas and newlines both separate: YAML block scalars (`globs: >` or `|`) join lines into one string
      for (const part of raw.split(/[,\n]/)) {
        const trimmed = part
          .trim()
          .replace(/^["']|["']$/g, "")
          .trim()
        // Globs use forward slashes; users on Windows may type backslashes
        const normalized = trimmed.replace(/\\/g, "/")
        if (normalized) out.push(normalized)
      }
    }
    if (typeof value === "string") push(value)
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") push(item)
      }
    }
    return unique(out)
  }

  /** The agents allowlist: also a comma separated string or an array, but without path normalization */
  export function parseNames(value: unknown): string[] | undefined {
    if (value === undefined || value === null) return undefined
    const out: string[] = []
    const push = (raw: string) => {
      for (const part of raw.split(/[,\n]/)) {
        const trimmed = part
          .trim()
          .replace(/^["']|["']$/g, "")
          .trim()
        if (trimmed) out.push(trimmed)
      }
    }
    if (typeof value === "string") push(value)
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") push(item)
      }
    } else return undefined
    const result = unique(out)
    return result.length > 0 ? result : undefined
  }

  /**
   * Accepts only YAML booleans and the strings "true" / "false" (trimmed, case-insensitive). The strings are needed
   * because ConfigMarkdown's lenient parsing fallback can leave values as strings.
   */
  export function parseBool(value: unknown): boolean | undefined {
    if (typeof value === "boolean") return value
    if (typeof value === "string") {
      const v = value.trim().toLowerCase()
      if (v === "true") return true
      if (v === "false") return false
    }
    return undefined
  }

  function unique(items: string[]) {
    return Array.from(new Set(items))
  }

  function hasOwn(raw: Record<string, unknown>, key: string) {
    return Object.prototype.hasOwnProperty.call(raw, key)
  }

  function fail(reason: Text.Pair): ParseResult {
    return { ok: false, reason }
  }

  /** A string or an array of strings; anything else is a type error */
  function readStringList(value: unknown): { ok: true; items: string[] } | { ok: false } {
    if (typeof value === "string") return { ok: true, items: parsePatterns(value) }
    if (Array.isArray(value)) {
      if (!value.every((item) => typeof item === "string")) return { ok: false }
      return { ok: true, items: parsePatterns(value) }
    }
    return { ok: false }
  }

  function readNames(value: unknown): { ok: true; items: string[] | undefined } | { ok: false } {
    if (typeof value === "string") return { ok: true, items: parseNames(value) }
    if (Array.isArray(value)) {
      if (!value.every((item) => typeof item === "string")) return { ok: false }
      return { ok: true, items: parseNames(value) }
    }
    return { ok: false }
  }

  /**
   * Whether the frontmatter is non-empty. gray-matter returns an empty object for a missing `---` block, an empty
   * one, or one with only comments; such `.mdc` files fail with a missing alwaysApply.
   */
  export function hasFields(data: unknown): boolean {
    return !!data && typeof data === "object" && !Array.isArray(data) && Object.keys(data).length > 0
  }

  /**
   * Derives how the rule applies. Precedence follows Cursor: alwaysApply, then globs, then description, then manual.
   */
  export function classify(input: { alwaysApply: boolean; globs: string[]; description: string }): {
    type: Type
    globs: string[]
  } {
    if (input.alwaysApply === true) return { type: "always", globs: input.globs }
    if (input.globs.length > 0) return { type: "auto", globs: input.globs }
    if (input.description) return { type: "agent-requested", globs: [] }
    return { type: "manual", globs: [] }
  }

  export function parse(data: unknown): ParseResult {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return fail(Reason.missingAlwaysApply)
    }
    const raw = data as Record<string, unknown>

    if (!hasOwn(raw, "alwaysApply")) return fail(Reason.missingAlwaysApply)
    const alwaysApply = parseBool(raw["alwaysApply"])
    if (alwaysApply === undefined) return fail(Reason.invalidAlwaysApply)

    let description = ""
    if (hasOwn(raw, "description")) {
      if (typeof raw["description"] !== "string") return fail(Reason.descriptionType)
      description = raw["description"].trim()
    }

    let declared: string[] = []
    if (hasOwn(raw, "globs")) {
      const globs = readStringList(raw["globs"])
      if (!globs.ok) return fail(Reason.globsType)
      declared = globs.items
    }

    let name: string | undefined
    if (hasOwn(raw, "name")) {
      if (typeof raw["name"] !== "string") return fail(Reason.nameType)
      name = raw["name"].trim() || undefined
    }

    let exclude: string[] = []
    if (hasOwn(raw, "exclude")) {
      const parsed = readStringList(raw["exclude"])
      if (!parsed.ok) return fail(Reason.excludeType)
      exclude = parsed.items
    }

    let agents: string[] | undefined
    if (hasOwn(raw, "agents")) {
      const parsed = readNames(raw["agents"])
      if (!parsed.ok) return fail(Reason.agentsType)
      agents = parsed.items
    }

    const classified = classify({ alwaysApply, globs: declared, description })

    return {
      ok: true,
      value: {
        name,
        description,
        globs: classified.globs,
        exclude,
        agents,
        alwaysApply,
        type: classified.type,
      },
    }
  }
}
