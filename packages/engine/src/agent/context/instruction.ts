import path from "path"
import { Global } from "../../infra/global"
import { Filesystem } from "@merakcode/util/filesystem"
import { Config } from "@merakcode/engine/agent/settings/index"
import { Instance } from "../../infra/project/instance"
import { Workspace } from "../../infra/project/workspace"
import { Flag } from "../../infra/flag/flag"
import { Log } from "@merakcode/log/logger"
import { ContextClaims } from "../session/context-claims"
import type { Message } from "../session/message"
import { Glob } from "@merakcode/util/glob"

const log = Log.create({ service: "instruction" })

const FILES = [
  "AGENTS.md", // de facto standard (agents.md)
  "CLAUDE.md", // Claude Code compatibility
]

function globalFiles() {
  const files: string[] = []
  if (Flag.MERAKCODE_CONFIG_DIR) {
    files.push(path.join(Flag.MERAKCODE_CONFIG_DIR, "AGENTS.md"))
  }
  files.push(path.join(Global.Path.config, "AGENTS.md"))
  if (!Flag.MERAKCODE_DISABLE_CLAUDE_CODE_PROMPT) {
    files.push(path.join(Global.Path.home, ".claude", "CLAUDE.md"))
  }
  return files
}

async function resolveRelative(instruction: string): Promise<string[]> {
  if (!Flag.MERAKCODE_DISABLE_PROJECT_CONFIG) {
    return Filesystem.globUp(instruction, Instance.directory, Instance.worktree).catch(() => [])
  }
  if (!Flag.MERAKCODE_CONFIG_DIR) {
    log.warn(
      `Skipping relative instruction "${instruction}" - no MERAKCODE_CONFIG_DIR set while project config is disabled`,
    )
    return []
  }
  return Filesystem.globUp(instruction, Flag.MERAKCODE_CONFIG_DIR, Flag.MERAKCODE_CONFIG_DIR).catch(() => [])
}

export namespace InstructionPrompt {
  /**
   * File names recognized as instruction files; within a directory the first existing one wins. Also used when the
   * settings page creates an instruction file.
   */
  export const FILENAMES: readonly string[] = FILES

  /**
   * Precedence statement for instruction blocks. Ordering alone conveys "more specific wins" only unreliably, so the
   * model is told explicitly; otherwise it has to guess when parent and child directory instructions conflict.
   */
  export const PRECEDENCE_NOTE = [
    "The instructions below are ordered from general to specific.",
    "When two instructions conflict, follow the one that appears later.",
    "Directory-scoped instructions take precedence over repository-wide ones for files inside that directory.",
  ].join(" ")

  export function clear(messageID: string) {
    ContextClaims.clear(messageID)
  }

  /** Walks up from start to stop collecting each directory's first instruction file, deepest first */
  async function chainUp(start: string, stop: string) {
    const result: string[] = []
    let current = path.resolve(start)
    const end = path.resolve(stop)
    while (true) {
      const found = await find(current)
      if (found) result.push(found)
      if (current === end) break
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
    return result
  }

  export async function systemPaths() {
    const config = await Config.get()
    const paths = new Set<string>()

    // Global first, then project files from shallow to deep: general to specific, as PRECEDENCE_NOTE states.
    for (const file of globalFiles()) {
      if (await Filesystem.isFile(file)) {
        paths.add(path.resolve(file))
        break
      }
    }

    if (!Flag.MERAKCODE_DISABLE_PROJECT_CONFIG) {
      // Each workspace root is scanned on its own; results only join the shared path set.
      const roots = Instance.workspace.folders.map((f) => ({
        start: f.path,
        stop: f.worktree === "/" ? f.path : f.worktree,
      }))
      // The primary folder is also in folders.
      const seen = new Set<string>()
      for (const root of roots) {
        const key = path.resolve(root.start)
        if (seen.has(key)) continue
        seen.add(key)
        // Each directory picks its own first existing file name, like find(), not one name for the whole chain.
        const chain = await chainUp(root.start, root.stop)
        chain.reverse().forEach((p) => paths.add(p))
      }
    }

    if (config.instructions) {
      for (let instruction of config.instructions) {
        if (instruction.startsWith("https://") || instruction.startsWith("http://")) continue
        if (instruction.startsWith("~/")) {
          instruction = path.join(Global.Path.home, instruction.slice(2))
        }
        const matches = path.isAbsolute(instruction)
          ? await Array.fromAsync(
              new Glob(path.basename(instruction)).scan({
                cwd: path.dirname(instruction),
                absolute: true,
                onlyFiles: true,
              }),
            ).catch(() => [])
          : await resolveRelative(instruction)
        matches.forEach((p) => {
          paths.add(path.resolve(p))
        })
      }
    }

    return paths
  }

  export async function system() {
    const config = await Config.get()
    const paths = await systemPaths()

    const files = Array.from(paths).map(async (p) => {
      const content = await Filesystem.readText(p).catch(() => "")
      return content ? "Instructions from: " + p + "\n" + content : ""
    })

    const urls: string[] = []
    if (config.instructions) {
      for (const instruction of config.instructions) {
        if (instruction.startsWith("https://") || instruction.startsWith("http://")) {
          urls.push(instruction)
        }
      }
    }
    const fetches = urls.map((url) =>
      fetch(url, { signal: AbortSignal.timeout(5000) })
        .then((res) => (res.ok ? res.text() : ""))
        .catch(() => "")
        .then((x) => (x ? "Instructions from: " + url + "\n" + x : "")),
    )

    return Promise.all([...files, ...fetches]).then((result) => {
      const blocks = result.filter(Boolean)
      return blocks.length > 0 ? [PRECEDENCE_NOTE, ...blocks] : blocks
    })
  }

  export function loaded(messages: Message.FullMsg[]) {
    return ContextClaims.loaded(messages)
  }

  export async function find(dir: string) {
    for (const file of FILES) {
      const filepath = path.resolve(path.join(dir, file))
      if (await Filesystem.isFile(filepath)) return filepath
    }
  }

  /**
   * Instruction files between the target and its workspace folder, deepest first. The folder root itself is excluded
   * because systemPaths covers it.
   * includeSelf is for directory triggers (@ directory, grep/glob hits): the target is a directory and its own
   * instruction file counts too.
   */
  export async function chainFor(filepath: string, options?: { includeSelf?: boolean }) {
    const target = path.resolve(filepath)
    // Stop at the file's workspace folder so the walk never reaches another repository.
    const folder = Workspace.resolveFolder(Instance.workspace, target)
    const root = path.resolve(folder?.path ?? Instance.directory)

    const results: string[] = []
    let current = options?.includeSelf ? target : path.dirname(target)
    while (current.startsWith(root) && current !== root) {
      const found = await find(current)
      if (found && found !== target) results.push(found)
      current = path.dirname(current)
    }
    return results
  }

  export async function resolve(
    messages: Message.FullMsg[],
    filepath: string,
    messageID: string,
    options?: { includeSelf?: boolean },
  ) {
    const system = await systemPaths()
    const already = loaded(messages)
    const results: { filepath: string; content: string }[] = []

    for (const found of await chainFor(filepath, options)) {
      if (system.has(found) || already.has(found) || ContextClaims.isClaimed(messageID, found)) continue
      ContextClaims.claim(messageID, found)
      const content = await Filesystem.readText(found).catch(() => undefined)
      if (content) {
        results.push({ filepath: found, content: "Instructions from: " + found + "\n" + content })
      }
    }

    // chainFor is deepest first; reverse to shallow first, i.e. general to specific as PRECEDENCE_NOTE states.
    return results.reverse()
  }
}
