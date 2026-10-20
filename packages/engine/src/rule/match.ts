import path from "path"
import { Instance } from "../project/instance"
import { Workspace } from "../project/workspace"
import { Filesystem } from "@merakcode/util/filesystem"
import { Rule } from "./rule"
import { Glob } from "@merakcode/util/glob"

/**
 * Decides which rules match a file path.
 *
 * Kept separate because two error-prone points must be pinned down by unit tests: Windows path separators, and the
 * base that globs resolve against (a project rule's own root, or the file's workspace folder for global rules).
 * Inside the scanning or injection modules this logic would be buried in IO code.
 */
export namespace RuleMatch {
  const compiled = new Map<string, Glob | null>()

  function glob(pattern: string) {
    if (compiled.has(pattern)) return compiled.get(pattern)!
    let result: Glob | null = null
    try {
      result = new Glob(pattern)
    } catch {
      // An invalid glob must not break the rule chain; treat it as no match
      result = null
    }
    compiled.set(pattern, result)
    return result
  }

  /**
   * Posix path of target relative to base; undefined when target is not under base.
   * Glob only understands forward slashes, but path.relative returns backslashes on Windows; without normalizing,
   * every multi-level glob would silently fail to match there.
   */
  export function relativize(base: string, target: string): string | undefined {
    const rel = path.relative(path.resolve(base), path.resolve(target))
    if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || rel.startsWith("../")) return undefined
    if (path.isAbsolute(rel)) return undefined
    return rel.split(path.sep).join("/")
  }

  /**
   * Whether one pattern matches a relative path. Besides a literal match, supports two shorthands users almost always
   * write:
   * - a pattern without `/` (e.g. `*.ts`) also matches the basename; otherwise it would only match files at the root,
   *   while users mean .ts files in any directory
   * - a pattern ending in `/` (e.g. `src/`) means that whole subtree
   */
  function matchOne(pattern: string, rel: string) {
    const effective = pattern.endsWith("/") ? pattern + "**/*" : pattern
    if (glob(effective)?.match(rel)) return true
    if (!pattern.includes("/") && glob(pattern)?.match(path.posix.basename(rel))) return true
    return false
  }

  export function matchesPatterns(rel: string, patterns: string[]) {
    return patterns.some((pattern) => matchOne(pattern, rel))
  }

  /** The directory a rule's globs resolve against */
  export function baseFor(rule: Rule.Info, target: string) {
    // Global rules have no project root, so they resolve against the target's workspace folder; otherwise a global
    // rule's globs would follow the primary root in multi-root workspaces
    if (rule.scope === "global") {
      const folder = Workspace.resolveFolder(Instance.workspace, path.resolve(target))
      return path.resolve(folder?.path ?? Instance.directory)
    }
    return rule.root
  }

  export function matchesFile(rule: Rule.Info, filepath: string) {
    if (rule.globs.length === 0) return false
    const rel = relativize(baseFor(rule, filepath), filepath)
    if (rel === undefined) return false
    if (rule.exclude.length > 0 && matchesPatterns(rel, rule.exclude)) return false
    return matchesPatterns(rel, rule.globs)
  }

  /** Whether the rule applies to the agent. A rule without agents applies to all agents */
  export function allowsAgent(rule: Rule.Info, agent?: string) {
    if (!rule.agents || rule.agents.length === 0) return true
    if (!agent) return true
    return rule.agents.includes(agent)
  }

  /** Auto-attached rules to inject when filepath is touched */
  export async function resolve(filepath: string, options?: { agent?: string }) {
    return forFile(await Rule.all(), filepath, options)
  }

  /** Auto-attached rules to inject when filepath is touched, by ascending layer (general to specific) */
  export function forFile(rules: Rule.Info[], filepath: string, options?: { agent?: string }) {
    return rules
      .filter((rule) => rule.type === "auto")
      .filter((rule) => allowsAgent(rule, options?.agent))
      .filter((rule) => matchesFile(rule, filepath))
      .sort(order)
  }

  /**
   * Manual rules to attach when the user @-mentions a file. Matches the rule file path exactly, ignoring globs and
   * the agents gate: an explicit mention overrides them.
   */
  export async function resolveMention(filepath: string) {
    return forMention(await Rule.all(), filepath)
  }

  export function forMention(rules: Rule.Info[], filepath: string) {
    return rules
      .filter((rule) => rule.type === "manual")
      .filter((rule) => rule.filepath && Filesystem.sameFilepath(rule.filepath, filepath))
      .sort(order)
  }

  /**
   * The loaded rule (of any type) whose file path matches exactly. On Windows, paths differing only in drive letter
   * case or slashes are the same file.
   */
  export function byFilepath(rules: Rule.Info[], filepath: string) {
    return rules.find((rule) => rule.filepath && Filesystem.sameFilepath(rule.filepath, filepath))
  }

  /**
   * Rule order: ascending layer (source), then ascending rule root depth within a source. Pairs with PRECEDENCE_NOTE,
   * which says later rules win, so more specific rules come later.
   */
  export function order(a: Rule.Info, b: Rule.Info) {
    if (a.layer !== b.layer) return a.layer - b.layer
    const depth = (rule: Rule.Info) => rule.root.split(/[\\/]/).length
    const diff = depth(a) - depth(b)
    if (diff !== 0) return diff
    return a.filepath.localeCompare(b.filepath)
  }
}
