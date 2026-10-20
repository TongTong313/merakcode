import path from "path"
import { createHash } from "crypto"
import { pathToFileURL } from "url"
import { Filesystem } from "@merakcode/util/filesystem"

/**
 * Multi-root workspace model (like VS Code / Cursor workspaceFolders).
 *
 * - primary: the compatibility anchor, equal to Instance.directory
 * - folders: every root of the workspace; with a single root, length === 1 and path === primary
 * - The CLI and older clients send no folders and always get a single root
 */
export namespace Workspace {
  export type FolderInput = {
    name?: string
    path: string
  }

  export type Folder = {
    name: string
    path: string
    /** Git sandbox of this root; "/" outside git */
    worktree: string
  }

  export type Info = {
    primary: string
    folders: Folder[]
    /** Key for the Instance cache and State buckets; equals primary for a single root */
    key: string
    /** Workspace identity; only for multiple roots (undefined for a single root, which uses the normal project) */
    identity?: Identity
  }

  /**
   * Workspace identity, used to group sessions and config. It depends only on the set of folders (not their order
   * or path spelling), so reopening the same folders shows the same sessions.
   */
  export type Identity = {
    id: string
    fingerprint: string
  }

  function digest(value: string) {
    return createHash("sha256").update(value).digest("hex").slice(0, 16)
  }

  /** Fingerprint of the folder set; sorted, so order does not matter */
  export function fingerprint(folderPaths: string[]): string {
    const parts = folderPaths.map((f) => Filesystem.canonicalDirectory(f)).toSorted()
    return digest(parts.join("\0"))
  }

  /** Returns undefined for a single root (including CLI/TUI), which never takes the workspace path */
  export function identity(input: { directory: string; folders?: FolderInput[] }): Identity | undefined {
    const paths = normalizeFolderPaths(input.directory, input.folders)
    if (paths.length <= 1) return undefined
    const fp = fingerprint(paths)
    return { id: `ws_${fp}`, fingerprint: fp }
  }

  /** Finds the git sandbox cheaply, so extra roots do not run Project.fromDirectory and its storage writes */
  export async function resolveSandbox(directory: string): Promise<string> {
    const matches = Filesystem.up({ targets: [".git"], start: directory })
    const dotgit = await matches.next().then((x) => x.value)
    await matches.return()
    if (!dotgit) return "/"
    return Filesystem.normalize(path.dirname(dotgit))
  }

  export function folderName(directory: string, explicit?: string) {
    if (explicit?.trim()) return explicit.trim()
    const base = path.basename(Filesystem.normalize(directory))
    return base || directory
  }

  /**
   * Single root: key = normalize(primary), the existing Instance cache key.
   * Multiple roots: includes the workspace identity and the canonical path of every folder. The identity is
   * required, or opening a directory alone and as part of a workspace would share one Instance.
   */
  export function key(primary: string, folderPaths: string[], workspaceID?: string): string {
    const p = Filesystem.normalize(primary)
    if (folderPaths.length <= 1) {
      const only = folderPaths[0]
      if (!only || Filesystem.sameDirectory(only, p)) return p
    }
    const parts = folderPaths.map((f) => Filesystem.canonicalDirectory(f))
    return ["workspace", workspaceID ?? "", Filesystem.canonicalDirectory(p), ...parts].join("\0")
  }

  /** Folder paths in the same order as build (primary added if missing), to compute the Instance cache key early */
  export function normalizeFolderPaths(directory: string, folders?: FolderInput[]): string[] {
    const primary = Filesystem.normalize(directory)
    if (!folders?.length) return [primary]
    const paths = folders.map((f) => Filesystem.normalize(f.path))
    if (!paths.some((p) => Filesystem.sameDirectory(p, primary))) return [primary, ...paths]
    return paths
  }

  export async function build(input: {
    directory: string
    /** Git sandbox of the primary (from Project.fromDirectory) */
    primaryWorktree: string
    folders?: FolderInput[]
  }): Promise<Info> {
    const primary = Filesystem.normalize(input.directory)
    const paths = normalizeFolderPaths(primary, input.folders)
    const nameByPath = new Map<string, string | undefined>()
    for (const f of input.folders ?? []) {
      nameByPath.set(Filesystem.normalize(f.path), f.name)
    }
    const ordered = paths.map((p) => ({
      name: nameByPath.get(p),
      path: p,
    }))

    const folders: Folder[] = []
    for (const item of ordered) {
      const dir = item.path
      const worktree = Filesystem.sameDirectory(dir, primary) ? input.primaryWorktree : await resolveSandbox(dir)
      folders.push({
        name: folderName(dir, item.name),
        path: dir,
        worktree,
      })
    }

    const id = identity({ directory: primary, folders: input.folders })
    return {
      primary,
      folders,
      key: key(
        primary,
        folders.map((f) => f.path),
        id?.id,
      ),
      identity: id,
    }
  }

  /** Whether the path is inside any workspace folder (or its git worktree) */
  export function containsPath(info: Info, filepath: string) {
    for (const folder of info.folders) {
      if (Filesystem.contains(folder.path, filepath)) return true
      // worktree="/" outside git must not allow every path
      if (folder.worktree === "/") continue
      if (Filesystem.contains(folder.worktree, filepath)) return true
    }
    return false
  }

  /** Workspace folder that contains an absolute path (the deepest root wins) */
  export function resolveFolder(info: Info, filepath: string): Folder | undefined {
    let best: Folder | undefined
    let bestLen = -1
    for (const folder of info.folders) {
      if (!Filesystem.contains(folder.path, filepath)) continue
      const len = Filesystem.normalize(folder.path).length
      if (len > bestLen) {
        best = folder
        bestLen = len
      }
    }
    return best
  }

  /**
   * Inverse of displayPath: with multiple roots, maps `folderName` / `folderName/rel` back to its folder.
   *
   * Only applies when the first segment matches exactly one folder.name. Duplicate names are ambiguous (the primary
   * may also have a subdirectory of that name), so the path then stays relative to the primary instead of guessing.
   * Disabled for a single root: its displayPath has no prefix, so a normal subdirectory would be taken for a root.
   */
  function matchFolderPrefix(info: Info, input: string): { folder: Folder; rest: string } | undefined {
    if (info.folders.length <= 1) return undefined
    const normalized = input.replace(/\\/g, "/").replace(/^\.\//, "")
    const slash = normalized.indexOf("/")
    const head = slash > 0 ? normalized.slice(0, slash) : normalized
    const rest = slash > 0 ? normalized.slice(slash + 1) : ""
    const matched = info.folders.filter((f) => f.name === head)
    if (matched.length !== 1) return undefined
    return { folder: matched[0]!, rest }
  }

  /**
   * Resolves a tool path to an absolute path.
   * - Absolute: resolved, then checked to be inside a folder
   * - Relative with root: relative to the folder with that name or path
   * - Relative with a `folderName/...` prefix (multiple roots): inside that folder (the inverse of displayPath)
   * - Any other relative path: relative to the primary
   */
  export function resolvePath(
    info: Info,
    input: string,
    options?: { root?: string },
  ): { filepath: string; folder: Folder } | { error: string } {
    if (path.isAbsolute(input)) {
      const filepath = path.resolve(input)
      const folder = resolveFolder(info, filepath)
      if (!folder) return { error: `Path is outside workspace: ${filepath}` }
      return { filepath, folder }
    }

    if (options?.root) {
      const folder = info.folders.find(
        (f) => f.name === options.root || Filesystem.sameDirectory(f.path, options.root!),
      )
      if (!folder) return { error: `Unknown workspace folder: ${options.root}` }
      return { filepath: path.resolve(folder.path, input), folder }
    }

    const prefixed = matchFolderPrefix(info, input)
    if (prefixed) {
      const filepath = prefixed.rest ? path.resolve(prefixed.folder.path, prefixed.rest) : prefixed.folder.path
      return { filepath, folder: prefixed.folder }
    }

    const primaryFolder = info.folders.find((f) => Filesystem.sameDirectory(f.path, info.primary)) ?? info.folders[0]
    if (!primaryFolder) return { error: "Workspace has no folders" }
    return { filepath: path.resolve(primaryFolder.path, input), folder: primaryFolder }
  }

  /**
   * Resolves the File.list path: an empty path with multiple roots is undefined (the virtual top level); everything
   * else goes through resolveToolPath (folderName/rel prefixes and absolute paths).
   */
  export function resolveListPath(info: Info, dir?: string): string | undefined {
    const multi = info.folders.length > 1
    if (!dir || dir === "" || dir === ".") return multi ? undefined : info.primary
    if (path.isAbsolute(dir)) return path.resolve(dir)

    const byPath = info.folders.find((f) => Filesystem.sameDirectory(f.path, dir))
    if (byPath) return byPath.path

    return resolveToolPath(info, dir).filepath
  }

  /**
   * Search roots for tools: all folders without a path, otherwise the one resolved root.
   * Uses the same rules as resolveToolPath (including `folderName/rel`); otherwise when the model passes `beta/src`
   * from grep or index output back as the path, it would search a missing directory under the primary.
   */
  export function searchRoots(info: Info, searchPath?: string): string[] {
    if (!searchPath) return info.folders.map((f) => f.path)
    return [resolveToolPath(info, searchPath).filepath]
  }

  /** LSP workspaceFolders entries */
  export function lspFolders(info: Info): Array<{ name: string; uri: string }> {
    return info.folders.map((f) => ({
      name: f.name,
      uri: pathToFileURL(f.path).href,
    }))
  }

  /** Relative path for display: relative to its folder if any, otherwise to the primary */
  export function displayPath(info: Info, filepath: string): string {
    const folder = resolveFolder(info, filepath)
    if (folder) {
      const rel = path.relative(folder.path, filepath)
      if (info.folders.length > 1) return path.join(folder.name, rel || ".")
      return rel || "."
    }
    return path.relative(info.primary, filepath)
  }

  /**
   * Resolves a tool path: relative paths against the primary (or root), absolute paths as is.
   * Absolute paths outside the workspace are still returned (external_directory approval handles them) with an
   * undefined folder.
   */
  export function resolveToolPath(
    info: Info,
    input: string,
    options?: { root?: string },
  ): { filepath: string; folder?: Folder } {
    if (path.isAbsolute(input)) {
      const filepath = path.resolve(input)
      return { filepath, folder: resolveFolder(info, filepath) }
    }
    const resolved = resolvePath(info, input, options)
    if ("error" in resolved) {
      return { filepath: path.resolve(info.primary, input) }
    }
    return resolved
  }

  /** Parses the folders header JSON; returns undefined when invalid (the caller falls back to a single root) */
  export function parseFoldersHeader(raw: string | undefined): FolderInput[] | undefined {
    if (!raw?.trim()) return undefined
    const decoded = (() => {
      try {
        return decodeURIComponent(raw)
      } catch {
        return raw
      }
    })()
    try {
      const parsed = JSON.parse(decoded) as unknown
      if (!Array.isArray(parsed)) return undefined
      const folders: FolderInput[] = []
      for (const item of parsed) {
        if (!item || typeof item !== "object") continue
        const pathValue = (item as { path?: unknown }).path
        if (typeof pathValue !== "string" || !pathValue.trim()) continue
        const nameValue = (item as { name?: unknown }).name
        folders.push({
          path: pathValue,
          name: typeof nameValue === "string" ? nameValue : undefined,
        })
      }
      if (folders.length === 0) return undefined
      return folders
    } catch {
      return undefined
    }
  }
}
