import type { ConfigPermissionRule } from "@merakcode/sdk"
import { sameDir } from "../../lib/route"

export type RuleKind = "bash" | "edit"
export type Decision = "allow" | "ask" | "deny"

/** Turns a pattern such as "git push*" or "docs/**" into the prefix it stands for; a wildcard anywhere else has no meaning. */
function prefixOf(pattern: string) {
  let prefix = pattern.trim()
  for (const suffix of ["/**", "/*", ":*", "**", "*"]) {
    if (prefix.endsWith(suffix)) {
      prefix = prefix.slice(0, -suffix.length).trim()
      break
    }
  }
  return !prefix || /[*?[\]{}]/.test(prefix) ? undefined : prefix
}

/** The rule the form describes, for one project: a command prefix for running commands, a path prefix for writing files. */
export function ruleFromInput(
  kind: RuleKind,
  pattern: string,
  decision: Decision,
  project: string,
): ConfigPermissionRule | undefined {
  const prefix = prefixOf(pattern)
  if (!prefix) return
  return { project, ...(kind === "bash" ? { commandPrefix: prefix } : { pathPrefix: prefix }), decision }
}

/** The rules written for one project. */
export const projectRules = (rules: readonly ConfigPermissionRule[], project: string) =>
  rules.filter((rule) => rule.project && sameDir(rule.project, project))

export const sameRule = (a: ConfigPermissionRule, b: ConfigPermissionRule) =>
  a.project === b.project &&
  (a.tool ?? "") === (b.tool ?? "") &&
  (a.commandPrefix ?? "") === (b.commandPrefix ?? "") &&
  (a.pathPrefix ?? "") === (b.pathPrefix ?? "") &&
  a.decision === b.decision
