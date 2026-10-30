import path from "path"
import { z } from "zod"
import { Bus } from "../../../infra/bus"
import { BusEvent } from "../../../infra/bus/bus-event"
import { Config } from "@merakcode/engine/agent/settings/index"
import { ConfigMarkdown } from "../../../infra/config/markdown"
import { Flag } from "../../../infra/flag/flag"
import { Instance } from "../../../infra/project/instance"
import { Filesystem } from "@merakcode/util/filesystem"
import { Log } from "@merakcode/log/logger"
import { Text } from "../text"
import { RuleFrontmatter } from "./frontmatter"
import { Glob } from "@merakcode/util/glob"

const log = Log.create({ service: "rule" })

/**
 * Rule discovery and loading.
 *
 * Scans from each workspace folder root up to the worktree, since always-on rules must be enumerable to enter the
 * system prompt every turn. Subdirectories below a folder root (e.g. `packages/foo/.merakcode/rules` when the repo
 * root is open) are not scanned; scope is expressed with globs / alwaysApply in the `.mdc` frontmatter. Cross-project
 * user rules come only from `rules.user` in the global config; `rules/*.mdc` in the config directory is not scanned.
 */
export namespace Rule {
  // Broadcast by RuleWatch on external changes in rule directories; the settings page reloads its list on it.
  export const Event = {
    Updated: BusEvent.define("rule.updated", z.object({})),
  }

  /** Both `rule` and `rules` are accepted, like the singular/plural directories for command/agent/skill */
  const DIR_NAMES = ["rule", "rules"]
  /** Project directories that contain rules: native first, `.cursor` read for compatibility */
  const NATIVE_CONTAINER = ".merakcode"
  const EXTERNAL_CONTAINER = ".cursor"
  const RULE_GLOB = new Glob("**/*.mdc")

  /**
   * Per-rule byte limit; longer rules are truncated. A rule of hundreds of KB would take over the context and is
   * almost always a whole document added by mistake, so injecting it silently costs far more than truncating.
   */
  export const MAX_BYTES = 16 * 1024

  export const Source = z.enum(["user-config", "external", "native"])
  export type Source = z.infer<typeof Source>

  export const Scope = z.enum(["global", "project"])
  export type Scope = z.infer<typeof Scope>

  export const Type = z.enum(["always", "auto", "agent-requested", "manual"])
  export type Type = z.infer<typeof Type>

  /**
   * Injection layer per source. The values match the corresponding ContextAttach.Layer entries (pinned by a unit
   * test): lower is more general, higher is more specific, and later wins on conflict.
   * Native rules win over external .cursor rules: the native format is what the user configured in this product,
   * while the external directory is only read for compatibility.
   */
  export const LAYER: Record<Source, number> = {
    "user-config": 10,
    external: 20,
    native: 40,
  }

  export const Info = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    type: Type,
    source: Source,
    scope: Scope,
    layer: z.number(),
    /** Source file of the rule; an empty string for user-config rules, which have no file */
    filepath: z.string(),
    /** Directory globs resolve against (for project rules, the parent of the rule container directory) */
    root: z.string(),
    globs: z.array(z.string()),
    exclude: z.array(z.string()),
    agents: z.array(z.string()).optional(),
    content: z.string(),
    bytes: z.number(),
    truncated: z.boolean(),
  })
  export type Info = z.infer<typeof Info>

  export type LoadError = {
    filepath: string
    reason: string
  }

  export type Shadowed = {
    /** The .cursor/rules directory skipped as a whole */
    directory: string
    /** Number of native rules shadowing it */
    by: number
  }

  export type Loaded = {
    rules: Info[]
    errors: LoadError[]
    shadowed: Shadowed[]
  }

  function empty(): Loaded {
    return { rules: [], errors: [], shadowed: [] }
  }

  function merge(target: Loaded, source: Loaded) {
    target.rules.push(...source.rules)
    target.errors.push(...source.errors)
    target.shadowed.push(...source.shadowed)
  }

  /** Load results cached per directory, since multi-root workspaces share ancestor directories */
  const cache = Instance.state(() => new Map<string, Promise<Loaded>>())

  function cached(key: string, load: () => Promise<Loaded>) {
    const map = cache()
    let pending = map.get(key)
    if (!pending) {
      pending = load()
      map.set(key, pending)
    }
    return pending
  }

  function truncate(body: string) {
    const buffer = Buffer.from(body, "utf8").subarray(0, MAX_BYTES)
    return buffer.toString("utf8") + "\n\n[Rule content truncated: it exceeds the per-rule size limit]"
  }

  /** Directories from each workspace folder root up to the worktree, shallow to deep, deduplicated */
  export function projectChainDirs() {
    const dirs: string[] = []
    if (Flag.MERAKCODE_DISABLE_PROJECT_CONFIG) return dirs
    const seen = new Set<string>()
    for (const folder of Instance.workspace.folders) {
      const stop = folder.worktree === "/" ? folder.path : folder.worktree
      for (const dir of projectChain(folder.path, stop)) {
        const key = Filesystem.canonicalDirectory(dir)
        if (seen.has(key)) continue
        seen.add(key)
        dirs.push(dir)
      }
    }
    return dirs
  }

  /** Project rule roots watched by RuleWatch, from each folder up to the worktree */
  export function projectWatchRoots() {
    const roots: string[] = []
    for (const dir of projectChainDirs()) {
      const native = path.join(dir, NATIVE_CONTAINER)
      for (const name of DIR_NAMES) roots.push(path.join(native, name))
      if (!Flag.MERAKCODE_DISABLE_CURSOR_RULES) {
        roots.push(path.join(dir, EXTERNAL_CONTAINER, "rules"))
      }
    }
    return roots
  }

  /** Publishes session.error with kind=rule on parse failures; the dynamic import avoids a rule -> session cycle */
  async function emitParseError(filepath: string, reason: string) {
    try {
      const [{ Session }, { Message }] = await Promise.all([import("../../session"), import("../../session/message")])
      Bus.publish(Session.Event.Error, {
        error: new Message.ConfigParseError({
          kind: "rule",
          path: filepath,
          reason,
          messageKey: "error.configParse",
          params: { kind: "rule", path: filepath, reason },
          message: `Failed to parse rule ${filepath}: ${reason}`,
        }).toObject(),
      })
    } catch {
      // There may be no Instance Bus yet in tests or early startup
    }
  }

  /** Reads and parses one rule file. Failures are recorded, not thrown: one broken rule must not disable all rules */
  async function load(
    into: Loaded,
    input: {
      filepath: string
      rulesDir: string
      root: string
      source: Source
      scope: Scope
    },
  ) {
    const md = await ConfigMarkdown.parse(input.filepath).catch(async (err) => {
      const reason = ConfigMarkdown.FrontmatterError.isInstance(err)
        ? err.data.message
        : err instanceof Error
          ? err.message
          : String(err)
      into.errors.push({ filepath: input.filepath, reason })
      log.error("failed to load rule", { rule: input.filepath, err })
      await emitParseError(input.filepath, reason)
      return undefined
    })
    if (!md) return

    // ConfigMarkdown.parse does not always throw on malformed YAML: gray-matter caches a partial object before
    // throwing, the lenient retry hits that cache, and the result is an empty frontmatter with `---` and the body
    // treated as content. For a rule that silently drops every condition and turns it into a manual rule, so it must
    // be recorded as an error, or the user would think the rule is in effect.
    // Load failure reasons appear in settings, /context and errors, so they are recorded in the UI language
    const body = md.content.trim()
    if (body.startsWith("---")) {
      const reason = await Text.pick({
        zh: "frontmatter 解析失败（YAML 格式非法）",
        en: "Failed to parse the frontmatter (invalid YAML)",
      })
      into.errors.push({ filepath: input.filepath, reason })
      log.error("failed to parse rule frontmatter", { rule: input.filepath })
      await emitParseError(input.filepath, reason)
      return
    }

    // An `.mdc` must be a valid rule: no --- block, an empty or comment-only block, a missing alwaysApply or a
    // mistyped field are all recorded as errors, never skipped silently. `.md` files are not scanned.
    const parsed = RuleFrontmatter.parse(md.data)
    if (!parsed.ok) {
      const reason = await Text.pick(parsed.reason)
      into.errors.push({ filepath: input.filepath, reason })
      log.error("failed to parse rule frontmatter", { rule: input.filepath, reason })
      await emitParseError(input.filepath, reason)
      return
    }

    if (!body) {
      // A rule with frontmatter but no body says nothing when injected; skip it and record an error
      const reason = await Text.pick({ zh: "规则正文为空", en: "The rule body is empty" })
      into.errors.push({ filepath: input.filepath, reason })
      await emitParseError(input.filepath, reason)
      return
    }

    const relative = path
      .relative(input.rulesDir, input.filepath)
      .split(path.sep)
      .join("/")
      .replace(/\.mdc$/i, "")
    const name = parsed.value.name || relative || path.basename(input.filepath)

    const truncated = Buffer.byteLength(body, "utf8") > MAX_BYTES
    const content = truncated ? truncate(body) : body

    into.rules.push({
      id: path.resolve(input.filepath),
      name,
      description: parsed.value.description,
      type: parsed.value.type,
      source: input.source,
      scope: input.scope,
      layer: LAYER[input.source],
      filepath: path.resolve(input.filepath),
      root: path.resolve(input.root),
      globs: parsed.value.globs,
      exclude: parsed.value.exclude,
      agents: parsed.value.agents,
      content,
      bytes: Buffer.byteLength(content, "utf8"),
      truncated,
    })
  }

  async function listMdc(rulesDir: string) {
    if (!(await Filesystem.isDir(rulesDir))) return [] as string[]
    return Array.fromAsync(
      RULE_GLOB.scan({ cwd: rulesDir, absolute: true, onlyFiles: true, followSymlinks: true }),
    ).catch((error) => {
      log.error("failed to scan rules", { dir: rulesDir, error })
      return [] as string[]
    })
  }

  async function scan(into: Loaded, input: { rulesDir: string; root: string; source: Source; scope: Scope }) {
    const matches = await listMdc(input.rulesDir)
    const before = into.rules.length
    for (const match of matches.sort()) {
      await load(into, { ...input, filepath: match })
    }
    return into.rules.length - before
  }

  /**
   * Rules of one project directory: native `.merakcode/rules` first, falling back to `.cursor/rules` only when the
   * directory has no parsable native rule. The per-directory fallback works like AGENTS.md shadowing CLAUDE.md, but
   * it must be recorded; otherwise adding one native rule would silently hide a set of cursor rules.
   */
  function loadProjectDir(dir: string) {
    return cached(`project:${Filesystem.canonicalDirectory(dir)}`, async () => {
      const result = empty()
      const root = path.resolve(dir)

      let native = 0
      const nativeContainer = path.join(root, NATIVE_CONTAINER)
      for (const name of DIR_NAMES) {
        native += await scan(result, {
          rulesDir: path.join(nativeContainer, name),
          root,
          source: "native",
          scope: "project",
        })
      }

      if (Flag.MERAKCODE_DISABLE_CURSOR_RULES) return result

      const externalDir = path.join(root, EXTERNAL_CONTAINER, "rules")
      if (native > 0) {
        // An empty directory hides nothing; record shadowing only when it has .mdc files (broken ones included)
        const externalFiles = await listMdc(externalDir)
        if (externalFiles.length > 0) {
          result.shadowed.push({ directory: externalDir, by: native })
          log.warn("cursor rules shadowed by native rules", { directory: externalDir, native })
        }
        return result
      }
      await scan(result, { rulesDir: externalDir, root, source: "external", scope: "project" })
      return result
    })
  }

  /**
   * `config.rules.user`, the global rules text box in settings. Read only from the **global** config: a value in a
   * project's merakcode.json is ignored, otherwise a project could inject cross-project global rules, contradicting
   * the field's meaning. Projects add rules through .merakcode/rules/.
   */
  async function userConfigRules(): Promise<Info[]> {
    const global = await Config.global().catch((error) => {
      log.error("failed to load global config for user rules", { error })
      return undefined
    })
    const entries = global?.rules?.user ?? []
    const result: Info[] = []
    for (const [index, text] of entries.entries()) {
      const body = text.trim()
      if (!body) continue
      const truncated = Buffer.byteLength(body, "utf8") > MAX_BYTES
      const content = truncated ? truncate(body) : body
      result.push({
        id: `user-config:${index}`,
        name: `user-rule-${index + 1}`,
        description: "",
        type: "always",
        source: "user-config",
        scope: "global",
        layer: LAYER["user-config"],
        filepath: "",
        root: Instance.directory,
        globs: [],
        exclude: [],
        agents: undefined,
        content,
        bytes: Buffer.byteLength(content, "utf8"),
        truncated,
      })
    }
    return result
  }

  /** Directories from start up to stop, shallow to deep */
  function projectChain(start: string, stop: string) {
    const dirs: string[] = []
    let current = path.resolve(start)
    const end = path.resolve(stop)
    while (true) {
      dirs.push(current)
      if (current === end) break
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
    return dirs.reverse()
  }

  /**
   * Enumerable rules for the session: global `rules.user` plus each workspace folder root up to the worktree.
   */
  export const state = Instance.state(async (): Promise<Loaded> => {
    if (Flag.MERAKCODE_DISABLE_RULES) return empty()

    const result = empty()

    if (!Flag.MERAKCODE_DISABLE_PROJECT_CONFIG) {
      const seen = new Set<string>()
      for (const folder of Instance.workspace.folders) {
        const stop = folder.worktree === "/" ? folder.path : folder.worktree
        for (const dir of projectChain(folder.path, stop)) {
          const key = Filesystem.canonicalDirectory(dir)
          if (seen.has(key)) continue
          seen.add(key)
          merge(result, await loadProjectDir(dir))
        }
      }
    }

    result.rules.push(...(await userConfigRules()))
    result.rules.sort(compare)

    const names = new Map<string, string>()
    for (const rule of result.rules) {
      const existing = names.get(rule.name)
      if (existing) log.warn("duplicate rule name", { name: rule.name, existing, duplicate: rule.filepath })
      else names.set(rule.name, rule.filepath || rule.id)
    }

    return result
  })

  /** Ascending layer, then ascending rule root depth within a layer, like RuleMatch.order */
  function compare(a: Info, b: Info) {
    if (a.layer !== b.layer) return a.layer - b.layer
    const depth = (rule: Info) => rule.root.split(/[\\/]/).length
    const diff = depth(a) - depth(b)
    if (diff !== 0) return diff
    return (a.filepath || a.id).localeCompare(b.filepath || b.id)
  }

  export async function all() {
    return state().then((x) => x.rules)
  }

  export async function byType(type: Type) {
    return all().then((rules) => rules.filter((rule) => rule.type === type))
  }

  export async function get(name: string) {
    return all().then((rules) => rules.find((rule) => rule.name === name))
  }

  export async function errors() {
    return state().then((x) => x.errors)
  }

  /** .cursor/rules directories ignored entirely because native rules exist in the same directory */
  export async function shadowed() {
    return state().then((x) => x.shadowed)
  }

  export function invalidate() {
    state.invalidate()
    cache.invalidate()
  }

  export function invalidateAll() {
    state.invalidateAll()
    cache.invalidateAll()
  }
}
