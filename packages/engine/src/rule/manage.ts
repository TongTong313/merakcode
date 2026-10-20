import path from "path"
import { unlink } from "fs/promises"
import { GlobalBus } from "../bus/global"
import { Config } from "../config/config"
import { ConfigMarkdown } from "../config/markdown"
import { Flag } from "../flag/flag"
import { Global } from "../global"
import { Instance } from "../project/instance"
import { Workspace } from "../project/workspace"
import { InstructionPrompt } from "../session/instruction"
import { Filesystem } from "@merakcode/util/filesystem"
import { Log } from "@merakcode/log/logger"
import { Text } from "../util/text"
import { RuleFrontmatter } from "./frontmatter"
import { RuleManageContract } from "./manage-contract"
import { Rule } from "./rule"
import { RuleTemplate } from "./template"
import { Glob } from "@merakcode/util/glob"

const log = Log.create({ service: "rule.manage" })

/**
 * Rule management service for the settings page.
 *
 * It does three things: builds one snapshot from the three sources (global `rules.user`, project `.mdc` files and
 * instruction files such as AGENTS.md), applies commands to disk, and then invalidates caches and broadcasts
 * `rule.updated`. Injection semantics live elsewhere: `RuleFrontmatter.classify` still derives how a rule applies
 * from its frontmatter, and this module only writes valid frontmatter, so the settings page and the loader cannot
 * disagree about a rule's type.
 *
 * The snapshot must reflect the disk: `Rule.state()` on the injection path is cached, and the watcher can miss
 * external deletes. Listing drops files that no longer exist and invalidates the cache; deleting a file that is
 * already gone counts as success (idempotent).
 */
export namespace RuleManage {
  /**
   * View limit for raw text. Rules have a 16KB injection limit, but instruction files (AGENTS.md) can be large.
   * Beyond this only a preview is returned with clipped set, and the settings page refuses to save, since saving the
   * preview would truncate the user's file.
   */
  const VIEW_MAX_BYTES = 64 * 1024

  const NATIVE_RULES_DIR = path.join(".merakcode", "rules")
  const EXTERNAL_RULES_DIR = path.join(".cursor", "rules")

  type Snapshot = RuleManageContract.Snapshot
  type FileEntry = RuleManageContract.File
  type Target = RuleManageContract.Target
  type Command = RuleManageContract.Command
  type Result = RuleManageContract.Result
  type ErrorCode = RuleManageContract.ErrorInfo["code"]

  function posix(input: string) {
    return input.split(path.sep).join("/")
  }

  /**
   * Short display path: relative to its workspace folder (with the folder name in multi-root workspaces), `~/` under
   * the home directory, otherwise absolute
   */
  function label(filepath: string) {
    if (Instance.containsPath(filepath)) return posix(Workspace.displayPath(Instance.workspace, filepath))
    const rel = path.relative(Global.Path.home, filepath)
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return `~/${posix(rel)}`
    return posix(filepath)
  }

  function scopeOf(filepath: string): "project" | "global" {
    return Instance.containsPath(filepath) ? "project" : "global"
  }

  async function readText(filepath: string) {
    const raw = await Filesystem.readText(filepath).catch(() => "")
    const bytes = Buffer.byteLength(raw, "utf8")
    if (bytes <= VIEW_MAX_BYTES) return { content: raw, bytes, clipped: false }
    return {
      content: Buffer.from(raw, "utf8").subarray(0, VIEW_MAX_BYTES).toString("utf8"),
      bytes,
      clipped: true,
    }
  }

  /** `.mdc` name without its extension, computed like the fallback display name in Rule.load */
  function relativeName(filepath: string) {
    return path.basename(filepath).replace(/\.mdc$/i, "")
  }

  function kindOf(source: Rule.Source): RuleManageContract.FileKind {
    return source === "external" ? "external" : "native"
  }

  /** Whether the path is under a `.cursor` container (broken rules only have a filepath, no Rule.Info source) */
  function isExternalPath(filepath: string) {
    return /(?:^|\/)\.cursor\//i.test(filepath.replace(/\\/g, "/"))
  }

  /**
   * An `.mdc` entry. Loaded rules take their fields from `Rule.Info`, exactly as injected. Broken and shadowed rules
   * have no `Rule.Info`, so the file is parsed here; for errors such as an empty body the frontmatter is still valid,
   * so form mode stays available and the user need not edit YAML by hand.
   */
  async function entryFromMdc(input: {
    filepath: string
    kind: RuleManageContract.FileKind
    active: boolean
    problem?: string
    rule?: Rule.Info
  }): Promise<FileEntry> {
    const view = await readText(input.filepath)
    const parsed = await ConfigMarkdown.parse(input.filepath)
      .then((md) => {
        const body = md.content.trim()
        // A body starting with `---` means the frontmatter silently failed to parse (gray-matter's lenient fallback)
        if (body.startsWith("---")) return undefined
        const result = RuleFrontmatter.parse(md.data)
        return { body, fields: result.ok ? result.value : undefined }
      })
      .catch(() => undefined)

    const rule = input.rule
    const body = parsed?.body ?? ""
    return {
      filepath: input.filepath,
      label: label(input.filepath),
      kind: input.kind,
      scope: rule?.scope ?? scopeOf(input.filepath),
      name: rule?.name || parsed?.fields?.name || relativeName(input.filepath),
      description: rule?.description ?? parsed?.fields?.description ?? "",
      type: rule?.type ?? parsed?.fields?.type,
      alwaysApply: rule ? rule.type === "always" : parsed?.fields?.alwaysApply,
      globs: rule?.globs ?? parsed?.fields?.globs ?? [],
      exclude: rule?.exclude ?? parsed?.fields?.exclude ?? [],
      agents: rule?.agents ?? parsed?.fields?.agents,
      content: view.content,
      body,
      bytes: view.bytes,
      truncated: rule?.truncated ?? Buffer.byteLength(body, "utf8") > Rule.MAX_BYTES,
      clipped: view.clipped,
      active: input.active,
      problem: input.problem,
      structured: !!parsed?.fields && !view.clipped,
      // `.mdc` files only come from project directories (global rules are `rules.user`, with no file), so they are
      // always editable and removable
      editable: true,
      removable: true,
    }
  }

  /**
   * An instruction file entry. It has no frontmatter and is edited as plain text. The global ones (config directory,
   * ~/.claude) affect all projects, so a project settings page only previews them.
   */
  async function entryFromInstruction(filepath: string): Promise<FileEntry> {
    const view = await readText(filepath)
    const scope = scopeOf(filepath)
    return {
      filepath,
      label: label(filepath),
      kind: "instruction",
      scope,
      name: path.basename(filepath),
      description: "",
      type: undefined,
      alwaysApply: undefined,
      globs: [],
      exclude: [],
      agents: undefined,
      content: view.content,
      body: view.content,
      bytes: view.bytes,
      truncated: false,
      clipped: view.clipped,
      active: true,
      structured: false,
      editable: scope === "project",
      removable: scope === "project" && InstructionPrompt.FILENAMES.includes(path.basename(filepath)),
    }
  }

  const KIND_ORDER: Record<RuleManageContract.FileKind, number> = { native: 0, external: 1, instruction: 2 }

  /** Files in `.cursor/rules` directories shadowed by native rules: inactive but still viewable and editable */
  async function shadowedFiles(directories: string[]) {
    const glob = new Glob("**/*.mdc")
    const result: string[] = []
    for (const directory of directories) {
      const matches = await Array.fromAsync(
        glob.scan({ cwd: directory, absolute: true, onlyFiles: true, followSymlinks: true }),
      ).catch(() => [] as string[])
      result.push(...matches.sort())
    }
    return result
  }

  function targetId(kind: RuleManageContract.FileKind, directory: string) {
    return `${kind}:${Filesystem.canonicalDirectory(directory)}`
  }

  /**
   * Locations for new files: each workspace folder root, plus rule directories that already exist on the way up.
   * Listing every level up to the worktree would clutter the dropdown, and the root is almost always the choice.
   */
  async function targets(rules: Rule.Info[]): Promise<Target[]> {
    if (Flag.MERAKCODE_DISABLE_PROJECT_CONFIG) return []
    const result: Target[] = []
    const seen = new Set<string>()

    const push = (target: Target) => {
      if (seen.has(target.id)) return
      seen.add(target.id)
      result.push(target)
    }

    /** Directories with native rules, where a new `.cursor/rules` file would be shadowed immediately */
    const nativeRoots = new Set(
      rules.filter((rule) => rule.source === "native").map((rule) => Filesystem.canonicalDirectory(rule.root)),
    )

    for (const folder of Instance.workspace.folders) {
      const root = path.resolve(folder.path)
      const native = path.join(root, NATIVE_RULES_DIR)
      push({ id: targetId("native", native), kind: "native", directory: native, label: label(native), shadowed: false })

      if (!Flag.MERAKCODE_DISABLE_CURSOR_RULES) {
        const external = path.join(root, EXTERNAL_RULES_DIR)
        push({
          id: targetId("external", external),
          kind: "external",
          directory: external,
          label: label(external),
          shadowed: nativeRoots.has(Filesystem.canonicalDirectory(root)),
        })
      }

      const occupied = await InstructionPrompt.find(root)
      push({
        id: targetId("instruction", root),
        kind: "instruction",
        directory: root,
        label: label(root),
        shadowed: false,
        occupied,
      })
    }

    // Existing rule directories between the folder roots and the worktree can also receive new files
    for (const dir of Rule.projectWatchRoots()) {
      if (!(await Filesystem.isDir(dir))) continue
      const kind: RuleManageContract.FileKind = isExternalPath(dir) ? "external" : "native"
      if (kind === "external" && Flag.MERAKCODE_DISABLE_CURSOR_RULES) continue
      push({
        id: targetId(kind, dir),
        kind,
        directory: dir,
        label: label(dir),
        shadowed: kind === "external" && nativeRoots.has(Filesystem.canonicalDirectory(path.resolve(dir, "..", ".."))),
      })
    }

    return result
  }

  export async function read(): Promise<Snapshot> {
    return readOnce(false)
  }

  /**
   * Builds the snapshot. The injection cache may still hold deleted files; those are left out, and the cache is
   * invalidated and rescanned once so the settings page and the next turn both see what is on disk.
   */
  async function readOnce(retried: boolean): Promise<Snapshot> {
    const loaded = await Rule.state()
    const global = await Config.global().catch((error) => {
      log.error("failed to load global config", { error })
      return undefined
    })

    const user: RuleManageContract.UserRule[] = (global?.rules?.user ?? []).map((text, index) => {
      const bytes = Buffer.byteLength(text, "utf8")
      return { index, text, bytes, truncated: bytes > Rule.MAX_BYTES }
    })

    const files: FileEntry[] = []
    const listed = new Set<string>()
    const liveRules: Rule.Info[] = []
    let droppedMissing = false

    const keepFile = async (filepath: string) => {
      if (await Filesystem.exists(filepath)) return true
      droppedMissing = true
      return false
    }

    for (const rule of loaded.rules) {
      // user-config rules have no file and are listed under user
      if (!rule.filepath) {
        liveRules.push(rule)
        continue
      }
      if (!(await keepFile(rule.filepath))) continue
      if (listed.has(rule.filepath)) continue
      listed.add(rule.filepath)
      liveRules.push(rule)
      files.push(await entryFromMdc({ filepath: rule.filepath, kind: kindOf(rule.source), active: true, rule }))
    }

    for (const error of loaded.errors) {
      if (!(await keepFile(error.filepath))) continue
      if (listed.has(error.filepath)) continue
      listed.add(error.filepath)
      files.push(
        await entryFromMdc({
          filepath: error.filepath,
          kind: isExternalPath(error.filepath) ? "external" : "native",
          active: false,
          problem: error.reason,
        }),
      )
    }

    if (droppedMissing && !retried) {
      log.warn("rule files missing from disk; refreshing cache")
      Rule.invalidate()
      return readOnce(true)
    }

    for (const filepath of await shadowedFiles(loaded.shadowed.map((x) => x.directory))) {
      if (listed.has(filepath)) continue
      listed.add(filepath)
      files.push(
        await entryFromMdc({
          filepath,
          kind: "external",
          active: false,
          problem: await Text.pick({
            zh: "同目录存在原生规则，该 .cursor/rules 目录整体不加载",
            en: "Native rules exist in the same directory, so this whole .cursor/rules directory is not loaded",
          }),
        }),
      )
    }

    for (const filepath of await InstructionPrompt.systemPaths()) {
      if (listed.has(filepath)) continue
      listed.add(filepath)
      files.push(await entryFromInstruction(filepath))
    }

    files.sort((a, b) => {
      if (KIND_ORDER[a.kind] !== KIND_ORDER[b.kind]) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
      return a.label.localeCompare(b.label)
    })

    return {
      user,
      files,
      shadowed: loaded.shadowed.map((x) => ({ directory: x.directory, by: x.by })),
      targets: await targets(liveRules),
      disabled: {
        rules: Flag.MERAKCODE_DISABLE_RULES,
        cursorRules: Flag.MERAKCODE_DISABLE_CURSOR_RULES,
      },
    }
  }

  /**
   * The settings page shows message as is: engine messages are localized to the UI language, underlying errors are
   * passed through verbatim
   */
  async function fail(code: ErrorCode, message: string | Text.Pair, params?: Record<string, unknown>): Promise<Result> {
    const text = typeof message === "string" ? message : await Text.pick(message, params)
    return read()
      .catch(() => undefined)
      .then((snapshot) => ({ ok: false as const, error: { code, message: text }, snapshot }))
  }

  const MISSING_USER_RULE = { zh: "该用户规则已不存在", en: "This user rule no longer exists" }
  const MISSING_FILE = {
    zh: "该规则文件已不存在，请刷新后重试",
    en: "This rule file no longer exists. Refresh and try again.",
  }
  const GLOBAL_READONLY = {
    zh: "全局指令文件只能预览，请直接在编辑器中修改",
    en: "Global instruction files are preview-only here. Edit them in your editor.",
  }
  const TOO_LARGE = { zh: "文件过大，请直接在编辑器中修改", en: "The file is too large. Edit it in your editor." }

  /**
   * After writing project rule or instruction files: invalidates the instance cache and broadcasts, so the settings
   * page and the next turn see the change immediately
   */
  function notifyFiles() {
    Rule.invalidate()
    GlobalBus.emit("event", {
      directory: Instance.directory,
      payload: { type: Rule.Event.Updated.type, properties: {} },
    })
  }

  async function writeUser(entries: string[]) {
    // patchJsonc replaces arrays wholesale rather than merging, so removing an entry really persists.
    // skipDispose: editing a rule must not dispose the instance and interrupt running sessions; the rule cache is
    // invalidated separately.
    await Config.updateGlobal({ rules: { user: entries } }, { skipDispose: true })
    Rule.invalidateAll()
  }

  /**
   * Write targets must be entries in the current snapshot. The engine computes this allowlist itself, so no path
   * sent by the frontend can bypass it.
   */
  function locate(snapshot: Snapshot, filepath: string) {
    // canonicalDirectory only normalizes slashes, drive letter case and trailing slashes, so it works for files too
    const target = Filesystem.canonicalDirectory(path.resolve(filepath))
    return snapshot.files.find((file) => Filesystem.canonicalDirectory(file.filepath) === target)
  }

  function resolveInTarget(target: Target, filename: string) {
    const normalized = filename.replace(/\\/g, "/").trim()
    if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) return undefined
    const abs = path.resolve(target.directory, normalized)
    if (!Filesystem.contains(target.directory, abs)) return undefined
    return abs
  }

  function isEnoent(error: unknown) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT"
  }

  /** The goal is "file absent": ENOENT counts as success, other errors are rethrown */
  async function unlinkIfExists(filepath: string) {
    try {
      await unlink(filepath)
    } catch (error) {
      if (isEnoent(error)) return
      log.error("failed to delete rule file", { filepath, error })
      throw error
    }
  }

  export async function change(command: Command): Promise<Result> {
    try {
      return await apply(command)
    } catch (error) {
      // Write failures (permissions, read-only mounts, concurrent config writes) should not reach the settings page
      // as a 500; return a failure with a snapshot so the frontend still shows the real state.
      // Invalidate on failure too, otherwise ghost entries keep showing up in later read() calls.
      log.error("rule change failed", { type: command.type, error })
      notifyFiles()
      const message = error instanceof Error ? error.message : String(error)
      return fail(isEnoent(error) ? "not_found" : "write_failed", message)
    }
  }

  async function apply(command: Command): Promise<Result> {
    const snapshot = await read()

    switch (command.type) {
      case "user_add": {
        await writeUser([...snapshot.user.map((x) => x.text), command.text.trim()])
        break
      }
      case "user_update": {
        if (!snapshot.user[command.index]) return fail("not_found", MISSING_USER_RULE)
        const next = snapshot.user.map((x) => x.text)
        next[command.index] = command.text.trim()
        await writeUser(next)
        break
      }
      case "user_remove": {
        if (!snapshot.user[command.index]) return fail("not_found", MISSING_USER_RULE)
        await writeUser(snapshot.user.filter((x) => x.index !== command.index).map((x) => x.text))
        break
      }
      case "file_create": {
        const target = snapshot.targets.find((x) => x.id === command.targetId)
        if (!target)
          return fail("invalid_path", {
            zh: "新建位置不可用，请刷新后重试",
            en: "This location is not available. Refresh and try again.",
          })

        let filename = command.filename.trim()
        if (target.kind === "instruction") {
          if (!InstructionPrompt.FILENAMES.includes(filename)) {
            return fail(
              "invalid_filename",
              { zh: "指令文件名只能是 {names}", en: "The instruction file name must be one of {names}" },
              { names: InstructionPrompt.FILENAMES.join(" / ") },
            )
          }
        } else if (!/\.mdc$/i.test(filename)) {
          filename = `${filename}.mdc`
        }

        const abs = resolveInTarget(target, filename)
        if (!abs) return fail("invalid_filename", { zh: "文件名不合法", en: "Invalid file name" })
        if (await Filesystem.isFile(abs))
          return fail("already_exists", { zh: "同名文件已存在", en: "A file with this name already exists" })

        const lang = await Text.lang()
        const content =
          target.kind === "instruction"
            ? RuleTemplate.INSTRUCTION_PLACEHOLDER[lang]
            : command.fields
              ? RuleTemplate.build(command.fields, lang)
              : RuleTemplate.fresh(lang)

        await Filesystem.write(abs, content)
        notifyFiles()
        break
      }
      case "file_write": {
        const entry = locate(snapshot, command.filepath)
        if (!entry) return fail("not_found", MISSING_FILE)
        if (!entry.editable) return fail("not_editable", GLOBAL_READONLY)
        if (entry.clipped) return fail("too_large", TOO_LARGE)
        await Filesystem.write(entry.filepath, command.content)
        notifyFiles()
        break
      }
      case "file_write_fields": {
        const entry = locate(snapshot, command.filepath)
        if (!entry) return fail("not_found", MISSING_FILE)
        if (entry.kind === "instruction")
          return fail("invalid_path", {
            zh: "指令文件没有 frontmatter，请用源码模式编辑",
            en: "Instruction files have no frontmatter. Edit them in source mode.",
          })
        if (!entry.editable) return fail("not_editable", GLOBAL_READONLY)
        if (entry.clipped) return fail("too_large", TOO_LARGE)
        await Filesystem.write(entry.filepath, RuleTemplate.build(command.fields, await Text.lang()))
        notifyFiles()
        break
      }
      case "file_delete": {
        const entry = locate(snapshot, command.filepath)
        if (entry && !entry.removable)
          return fail("not_removable", {
            zh: "该文件不允许在设置页删除",
            en: "This file cannot be deleted from the settings page",
          })
        // Not in the snapshot: already deleted or never managed. Never unlink the path the frontend sent (that would
        // allow deleting arbitrary files); the goal state is reached, so succeed and refresh the cache.
        if (entry) await unlinkIfExists(entry.filepath)
        notifyFiles()
        break
      }
    }

    return { ok: true, snapshot: await read() }
  }
}
