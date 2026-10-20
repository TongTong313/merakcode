/**
 * Memory management for people (settings panel, CLI), as opposed to MemoryPrompt / MemoryRecall, which serve the model.
 *
 * All safety checks come from MemoryAccess (path checks, the four-type directory constraint, credential scanning
 * before writes). This module only lists, reads, writes and deletes entries and maintains the MEMORY.md index.
 */
import fs from "fs/promises"
import path from "path"
import { MemoryAccess } from "./access"
import { MemoryPath } from "./path"
import { MemoryScan } from "./scan"
import { Log } from "@merakcode/log/logger"
import { failure } from "@merakcode/log"
import { Filesystem } from "@merakcode/util/filesystem"
import { Text } from "../util/text"

export namespace MemoryManage {
  const log = Log.create({ service: "memory.manage" })
  export type Entry = {
    /** Path relative to the memory root, e.g. user/user_role.md (the form used in index links) */
    filename: string
    /** Absolute path, used by clients to open the file in an editor */
    path: string
    name: string | null
    description: string | null
    type: string | undefined
    mtimeMs: number
  }

  export type Snapshot = {
    /** Memory root directory, which clients can reveal in the file manager */
    directory: string
    /** Absolute path of MEMORY.md */
    entrypoint: string
    /** MEMORY.md content; this is what gets injected every turn, so the panel shows it as is */
    index: string
    entries: Entry[]
  }

  export type Result<T> = { ok: true; data: T } | { ok: false; error: string }

  /**
   * Lists the memory root, the index content and the entries of all four types, newest first, reusing MemoryScan's
   * cache and frontmatter parsing.
   */
  export async function list(): Promise<Snapshot> {
    const started = Date.now()
    const directory = MemoryPath.directory()
    const entrypoint = MemoryPath.entrypoint()
    const [index, headers] = await Promise.all([
      fs.readFile(entrypoint, "utf8").catch(() => ""),
      MemoryScan.files(directory),
    ]).catch((error) => {
      log.error("memory list failed", { duration: Date.now() - started, ...failure(error) })
      throw error
    })
    log.info("memory list completed", {
      duration: Date.now() - started,
      entries: headers.length,
      hasIndex: index.length > 0,
    })
    return {
      directory,
      entrypoint,
      index,
      entries: headers.map((header) => ({
        filename: normalize(header.filename),
        path: header.path,
        name: header.name,
        description: header.description,
        type: header.type,
        mtimeMs: header.mtimeMs,
      })),
    }
  }

  /** Reads one memory file. Paths outside the memory directory are rejected to prevent path traversal */
  export async function read(filePath: string): Promise<Result<{ path: string; content: string }>> {
    const started = Date.now()
    if (!MemoryAccess.isReadablePath(filePath)) {
      log.warn("memory read rejected", { duration: Date.now() - started, reason: "path_not_allowed" })
      return denied(filePath)
    }
    const resolved = path.resolve(filePath)
    const result = await fs.readFile(resolved, "utf8").then(
      (content) => ({ ok: true as const, content }),
      (error) => ({ ok: false as const, error }),
    )
    if (!result.ok) {
      log.warn("memory read failed", {
        duration: Date.now() - started,
        type: memoryType(resolved),
        ...failure(result.error),
      })
      return {
        ok: false,
        error: await Text.pick(
          { zh: "记忆文件不存在或不可读：{path}", en: "Memory file does not exist or cannot be read: {path}" },
          { path: filePath },
        ),
      }
    }
    log.info("memory read completed", {
      duration: Date.now() - started,
      type: memoryType(resolved),
      characters: result.content.length,
    })
    return { ok: true, data: { path: resolved, content: result.content } }
  }

  /**
   * Deletes one memory file and removes the MEMORY.md line pointing to it. A dangling index line would otherwise
   * be injected every turn and send the model to read a missing file.
   */
  export async function remove(filePath: string): Promise<Result<{ path: string }>> {
    const started = Date.now()
    if (!MemoryAccess.isWritablePath(filePath)) {
      log.warn("memory remove rejected", { duration: Date.now() - started, reason: "path_not_allowed" })
      return denied(filePath)
    }
    const resolved = path.resolve(filePath)
    if (resolved === path.resolve(MemoryPath.entrypoint())) {
      log.warn("memory remove rejected", { duration: Date.now() - started, reason: "entrypoint_protected" })
      return {
        ok: false,
        error: await Text.pick({
          zh: "MEMORY.md 是索引本体，不能删除；请删除具体的记忆条目",
          en: "MEMORY.md is the index itself and cannot be deleted; delete individual memory entries instead",
        }),
      }
    }

    const existed = await fs
      .stat(resolved)
      .then(() => true)
      .catch(() => false)
    if (!existed) {
      log.warn("memory remove failed", {
        duration: Date.now() - started,
        type: memoryType(resolved),
        reason: "not_found",
      })
      return {
        ok: false,
        error: await Text.pick(
          { zh: "记忆文件不存在：{path}", en: "Memory file does not exist: {path}" },
          { path: filePath },
        ),
      }
    }

    await fs.rm(resolved, { force: true }).catch((error) => {
      log.error("memory remove failed", {
        duration: Date.now() - started,
        type: memoryType(resolved),
        ...failure(error),
      })
      throw error
    })

    const entrypoint = MemoryPath.entrypoint()
    const index = await fs.readFile(entrypoint, "utf8").catch(() => undefined)
    let indexPruned = false
    if (index !== undefined) {
      const next = pruneIndex(index, path.relative(MemoryPath.directory(), resolved))
      indexPruned = next !== index
      if (indexPruned) await Filesystem.write(entrypoint, next)
    }

    MemoryScan.invalidate()
    log.info("memory remove completed", {
      duration: Date.now() - started,
      type: memoryType(resolved),
      indexPruned,
    })
    return { ok: true, data: { path: resolved } }
  }

  /**
   * Removes the MEMORY.md lines pointing to relativePath (shaped like `- [Title](user/x.md) - one-line hook`).
   * Compares link targets line by line instead of matching substrings, which would also remove user_role_extra.md
   * when deleting user_role.md.
   */
  export function pruneIndex(index: string, relativePath: string): string {
    const target = normalize(relativePath)
    if (!target) return index
    const lines = index.split("\n")
    const kept = lines.filter((line) => linkTarget(line) !== target)
    return kept.length === lines.length ? index : kept.join("\n")
  }

  /**
   * Target of the markdown link in a line, with separators normalized and any ./ prefix, query or anchor removed;
   * undefined when the line has no link
   */
  function linkTarget(line: string): string | undefined {
    const raw = line.match(/\]\(([^)]+)\)/)?.[1]
    if (!raw) return undefined
    return normalize(raw.split(/[?#]/)[0].trim().replace(/^\.\//, ""))
  }

  /** The index uses forward slashes, but path.relative returns backslashes on Windows */
  function normalize(value: string): string {
    return value.replace(/\\/g, "/")
  }

  function memoryType(filePath: string) {
    const relative = path.relative(MemoryPath.directory(), filePath)
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return "unknown"
    const type = normalize(relative).split("/")[0]
    return ["user", "feedback", "project", "reference"].includes(type) ? type : "unknown"
  }

  async function denied(filePath: string): Promise<{ ok: false; error: string }> {
    return {
      ok: false,
      error: await Text.pick(
        { zh: "路径不在记忆目录内，已拒绝：{path}", en: "Rejected: the path is outside the memory directory: {path}" },
        { path: filePath },
      ),
    }
  }
}
