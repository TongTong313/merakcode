import { createHash } from "node:crypto"
import { BusEvent } from "../bus/bus-event"
import z from "zod"
import { formatPatch, structuredPatch } from "diff"
import path from "path"
import fs from "fs"
import ignore from "ignore"
import { Log } from "@merakcode/log/logger"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"
import { Instance } from "../project/instance"
import { Workspace } from "../project/workspace"
import { Ripgrep } from "./ripgrep"
import fuzzysort from "fuzzysort"
import { Global } from "../global"

export namespace File {
  const log = Log.create({ service: "file" })

  export const Info = z
    .object({
      path: z.string(),
      added: z.number().int(),
      removed: z.number().int(),
      status: z.enum(["added", "deleted", "modified"]),
    })
    .meta({
      ref: "File",
    })

  export type Info = z.infer<typeof Info>

  export const Node = z
    .object({
      name: z.string(),
      path: z.string(),
      absolute: z.string(),
      type: z.enum(["file", "directory"]),
      ignored: z.boolean(),
    })
    .meta({
      ref: "FileNode",
    })
  export type Node = z.infer<typeof Node>

  export const Content = z
    .object({
      type: z.enum(["text", "binary"]),
      content: z.string(),
      diff: z.string().optional(),
      patch: z
        .object({
          oldFileName: z.string(),
          newFileName: z.string(),
          oldHeader: z.string().optional(),
          newHeader: z.string().optional(),
          hunks: z.array(
            z.object({
              oldStart: z.number(),
              oldLines: z.number(),
              newStart: z.number(),
              newLines: z.number(),
              lines: z.array(z.string()),
            }),
          ),
          index: z.string().optional(),
        })
        .optional(),
      encoding: z.literal("base64").optional(),
      mimeType: z.string().optional(),
      /**
       * sha1 of the raw text; sent back as checksum to PUT /file/content, which returns 409 if the file changed since
       */
      checksum: z.string().optional(),
    })
    .meta({
      ref: "FileContent",
    })
  export type Content = z.infer<typeof Content>

  const binaryExtensions = new Set([
    "exe",
    "dll",
    "pdb",
    "bin",
    "so",
    "dylib",
    "o",
    "a",
    "lib",
    "wav",
    "mp3",
    "ogg",
    "oga",
    "ogv",
    "ogx",
    "flac",
    "aac",
    "wma",
    "m4a",
    "weba",
    "mp4",
    "avi",
    "mov",
    "wmv",
    "flv",
    "webm",
    "mkv",
    "zip",
    "tar",
    "gz",
    "gzip",
    "bz",
    "bz2",
    "bzip",
    "bzip2",
    "7z",
    "rar",
    "xz",
    "lz",
    "z",
    "pdf",
    "doc",
    "docx",
    "ppt",
    "pptx",
    "xls",
    "xlsx",
    "dmg",
    "iso",
    "img",
    "vmdk",
    "ttf",
    "otf",
    "woff",
    "woff2",
    "eot",
    "sqlite",
    "db",
    "mdb",
    "apk",
    "ipa",
    "aab",
    "xapk",
    "app",
    "pkg",
    "deb",
    "rpm",
    "snap",
    "flatpak",
    "appimage",
    "msi",
    "msp",
    "jar",
    "war",
    "ear",
    "class",
    "kotlin_module",
    "dex",
    "vdex",
    "odex",
    "oat",
    "art",
    "wasm",
    "wat",
    "bc",
    "ll",
    "s",
    "ko",
    "sys",
    "drv",
    "efi",
    "rom",
    "com",
    "bat",
    "cmd",
    "ps1",
    "sh",
    "bash",
    "zsh",
    "fish",
  ])

  const imageExtensions = new Set([
    "png",
    "jpg",
    "jpeg",
    "gif",
    "bmp",
    "webp",
    "ico",
    "tif",
    "tiff",
    "svg",
    "svgz",
    "avif",
    "apng",
    "jxl",
    "heic",
    "heif",
    "raw",
    "cr2",
    "nef",
    "arw",
    "dng",
    "orf",
    "raf",
    "pef",
    "x3f",
  ])

  function isImageByExtension(filepath: string): boolean {
    const ext = path.extname(filepath).toLowerCase().slice(1)
    return imageExtensions.has(ext)
  }

  function getImageMimeType(filepath: string): string {
    const ext = path.extname(filepath).toLowerCase().slice(1)
    const mimeTypes: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      bmp: "image/bmp",
      webp: "image/webp",
      ico: "image/x-icon",
      tif: "image/tiff",
      tiff: "image/tiff",
      svg: "image/svg+xml",
      svgz: "image/svg+xml",
      avif: "image/avif",
      apng: "image/apng",
      jxl: "image/jxl",
      heic: "image/heic",
      heif: "image/heif",
    }
    return mimeTypes[ext] || "image/" + ext
  }

  function isBinaryByExtension(filepath: string): boolean {
    const ext = path.extname(filepath).toLowerCase().slice(1)
    return binaryExtensions.has(ext)
  }

  function isImage(mimeType: string): boolean {
    return mimeType.startsWith("image/")
  }

  async function shouldEncode(mimeType: string): Promise<boolean> {
    const type = mimeType.toLowerCase()
    log.info("shouldEncode", { type })
    if (!type) return false

    if (type.startsWith("text/")) return false
    if (type.includes("charset=")) return false

    const parts = type.split("/", 2)
    const top = parts[0]

    const tops = ["image", "audio", "video", "font", "model", "multipart"]
    if (tops.includes(top)) return true

    return false
  }

  export const Event = {
    Edited: BusEvent.define(
      "file.edited",
      z.object({
        file: z.string(),
      }),
    ),
  }

  const state = Instance.state(async () => {
    type Entry = { files: string[]; dirs: string[] }
    let cache: Entry = { files: [], dirs: [] }
    let fetching = false

    const isGlobalHome = Instance.directory === Global.Path.home && Instance.project.id === "global"

    const fn = async (result: Entry) => {
      // Disable scanning if in root of file system
      if (Instance.directory === path.parse(Instance.directory).root) return
      fetching = true

      try {
        if (isGlobalHome) {
          const dirs = new Set<string>()
          const ignore = new Set<string>()

          if (process.platform === "darwin") ignore.add("Library")
          if (process.platform === "win32") ignore.add("AppData")

          const ignoreNested = new Set(["node_modules", "dist", "build", "target", "vendor"])
          const shouldIgnore = (name: string) => name.startsWith(".") || ignore.has(name)
          const shouldIgnoreNested = (name: string) => name.startsWith(".") || ignoreNested.has(name)

          const top = await fs.promises
            .readdir(Instance.directory, { withFileTypes: true })
            .catch(() => [] as fs.Dirent[])

          for (const entry of top) {
            if (!entry.isDirectory()) continue
            if (shouldIgnore(entry.name)) continue
            dirs.add(entry.name + "/")

            const base = path.join(Instance.directory, entry.name)
            const children = await fs.promises.readdir(base, { withFileTypes: true }).catch(() => [] as fs.Dirent[])
            for (const child of children) {
              if (!child.isDirectory()) continue
              if (shouldIgnoreNested(child.name)) continue
              dirs.add(entry.name + "/" + child.name + "/")
            }
          }

          result.dirs = Array.from(dirs).toSorted()
          cache = result
          return
        }

        const set = new Set<string>()
        const multi = Instance.workspace.folders.length > 1
        // Multi-root: index with a folder.name prefix so equal relative paths in different roots do not collide
        const roots = Instance.workspace.folders.map((f) => ({
          cwd: f.path,
          prefix: multi ? f.name : "",
          worktree: f.worktree === "/" ? f.path : f.worktree,
        }))

        for (const root of roots) {
          for await (const file of Ripgrep.files({ cwd: root.cwd })) {
            const indexed = root.prefix ? `${root.prefix}/${file}` : file
            result.files.push(indexed)
            let current = indexed
            while (true) {
              const dir = path.dirname(current)
              if (dir === ".") break
              if (dir === current) break
              current = dir
              if (set.has(dir)) continue
              set.add(dir)
              result.dirs.push(dir + "/")
            }
          }

          let ignored = (_: string) => false
          const ig = ignore()
          const gitignoreFile = path.join(root.worktree, ".gitignore")
          if (await Filesystem.isFile(gitignoreFile)) ig.add(await Filesystem.readText(gitignoreFile))
          const ignoreFile = path.join(root.worktree, ".ignore")
          if (await Filesystem.isFile(ignoreFile)) ig.add(await Filesystem.readText(ignoreFile))
          ignored = ig.ignores.bind(ig)

          const walkAllDirs = async (dir: string, prefix: string) => {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[])
            for (const entry of entries) {
              if (!entry.isDirectory()) continue
              if (entry.name === ".git") continue
              const rel = prefix ? `${prefix}/${entry.name}` : entry.name
              // Ignore rules are relative to each root's cwd, without the multi-root prefix
              const ignoreRel =
                root.prefix && rel.startsWith(root.prefix + "/") ? rel.slice(root.prefix.length + 1) : rel
              if (ignored(ignoreRel + "/")) continue
              if (!set.has(rel)) {
                set.add(rel)
                result.dirs.push(rel + "/")
              }
              await walkAllDirs(path.join(dir, entry.name), rel)
            }
          }
          await walkAllDirs(root.cwd, root.prefix)
        }

        cache = result
      } catch (error) {
        log.warn("file index scan failed", { directory: Instance.directory, error })
      } finally {
        fetching = false
      }
    }
    const initial = fn(cache)

    return {
      async files() {
        await initial
        if (!fetching) {
          fn({
            files: [],
            dirs: [],
          })
        }
        return cache
      },
    }
  })

  export function init() {
    state()
  }

  /**
   * Git changes of all workspace folders (each root is its own repository, grouped per repository like VS Code source
   * control). Paths match the index and display layer: `folderName/rel` for multi-root, relative to the primary
   * otherwise.
   */
  export async function status() {
    const workspace = Instance.workspace
    const multi = workspace.folders.length > 1
    const changedFiles: Info[] = []
    const seen = new Set<string>()

    // git prints paths relative to the worktree; resolve them to absolute paths before computing display paths, since
    // path.relative on a relative path resolves against process.cwd() and gives wrong results.
    const display = (worktree: string, gitPath: string) => {
      const full = path.resolve(worktree, gitPath)
      if (multi) return Workspace.displayPath(workspace, full)
      return path.relative(Instance.directory, full)
    }

    for (const folder of workspace.folders) {
      const worktree = folder.worktree
      if (worktree === "/") continue
      if (seen.has(worktree)) continue
      seen.add(worktree)

      const diffOutput = (
        await Process.run(["git", "-c", "core.quotepath=false", "diff", "--numstat", "HEAD"], {
          cwd: worktree,
          nothrow: true,
        })
      ).text()

      if (diffOutput.trim()) {
        for (const line of diffOutput.trim().split("\n")) {
          const [added, removed, filepath] = line.split("\t")
          if (!filepath) continue
          changedFiles.push({
            path: display(worktree, filepath),
            added: added === "-" ? 0 : parseInt(added, 10),
            removed: removed === "-" ? 0 : parseInt(removed, 10),
            status: "modified",
          })
        }
      }

      const untrackedOutput = (
        await Process.run(["git", "-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard"], {
          cwd: worktree,
          nothrow: true,
        })
      ).text()

      if (untrackedOutput.trim()) {
        for (const filepath of untrackedOutput.trim().split("\n")) {
          if (!filepath) continue
          const content = await Filesystem.readText(path.resolve(worktree, filepath)).catch(() => undefined)
          if (content === undefined) continue
          changedFiles.push({
            path: display(worktree, filepath),
            added: content.split("\n").length,
            removed: 0,
            status: "added",
          })
        }
      }

      const deletedOutput = (
        await Process.run(["git", "-c", "core.quotepath=false", "diff", "--name-only", "--diff-filter=D", "HEAD"], {
          cwd: worktree,
          nothrow: true,
        })
      ).text()

      if (deletedOutput.trim()) {
        for (const filepath of deletedOutput.trim().split("\n")) {
          if (!filepath) continue
          changedFiles.push({
            path: display(worktree, filepath),
            added: 0,
            removed: 0, // Could get original line count but would require another git command
            status: "deleted",
          })
        }
      }
    }

    return changedFiles
  }

  export async function read(file: string): Promise<Content> {
    using _ = log.time("read", { file })
    const project = Instance.project

    // Global plan files may be read: Global.Path.data/plans/*.md (absolute paths outside the project repository)
    const normalizedFile = path.normalize(file)
    const plansDataDir = path.join(Global.Path.data, "plans")
    const isGlobalPlan =
      normalizedFile.endsWith(".md") &&
      (normalizedFile.startsWith(plansDataDir + path.sep) || normalizedFile.startsWith(plansDataDir + "/"))

    // Multi-root: the input may be an absolute path from the UI, `folderName/rel` from the index/display layer, or
    // relative to the primary. It must go through the shared resolver: path.join would append an absolute path to the
    // primary, missing the second root and silently redirecting outside paths into the project.
    const resolved = isGlobalPlan ? undefined : Workspace.resolveToolPath(Instance.workspace, file)
    const full = resolved ? resolved.filepath : normalizedFile

    // Paths outside the workspace may be read and previewed (e.g. agent edits on the desktop)

    // Fast path: check extension before any filesystem operations
    if (isImageByExtension(file)) {
      if (await Filesystem.isFile(full)) {
        const content = (await fs.promises.readFile(full).catch(() => Buffer.alloc(0))).toString("base64")
        const mimeType = getImageMimeType(file)
        return { type: "text", content, mimeType, encoding: "base64" }
      }
      return { type: "text", content: "" }
    }

    if (isBinaryByExtension(file)) {
      return { type: "binary", content: "" }
    }

    if (!(await Filesystem.isFile(full))) {
      return { type: "text", content: "" }
    }

    const mimeType = Filesystem.mimeType(full)
    const encode = await shouldEncode(mimeType)

    if (encode && !isImage(mimeType)) {
      return { type: "binary", content: "", mimeType }
    }

    if (encode) {
      const content = (await fs.promises.readFile(full).catch(() => Buffer.alloc(0))).toString("base64")
      return { type: "text", content, mimeType, encoding: "base64" }
    }

    // Return the raw text without trimming: the editor and review undo modify part of it and write it back, so a
    // trimmed trailing newline would be lost. The checksum covers the raw text so PUT /file/content can detect changes
    // made after the read.
    const content = await Filesystem.readText(full).catch(() => "")
    const checksum = createHash("sha1").update(content).digest("hex")

    // Run git in the worktree of the file's root: a second root is its own repository, invisible from the primary cwd
    const worktree =
      resolved?.folder?.worktree && resolved.folder.worktree !== "/" ? resolved.folder.worktree : undefined
    if (!isGlobalPlan && (worktree ?? (project.vcs === "git" ? Instance.worktree : undefined))) {
      const cwd = worktree ?? Instance.worktree
      const rel = path.relative(cwd, full).replace(/\\/g, "/")
      let diff = (await Process.run(["git", "diff", rel], { cwd, nothrow: true })).text()
      if (!diff.trim()) diff = (await Process.run(["git", "diff", "--staged", rel], { cwd, nothrow: true })).text()
      if (diff.trim()) {
        const original = (await Process.run(["git", "show", `HEAD:${rel}`], { cwd, nothrow: true })).text()
        const patch = structuredPatch(file, file, original, content, "old", "new", {
          context: Infinity,
          ignoreWhitespace: true,
        })
        const diff = formatPatch(patch)
        // File names were passed above, so structuredPatch always includes them (diff 9 types mark them optional)
        return { type: "text", content, checksum, patch: { ...patch, oldFileName: file, newFileName: file }, diff }
      }
    }
    return { type: "text", content, checksum }
  }

  /** Resolves the list input to an absolute directory; undefined for the virtual multi-root top level */
  function resolveListDir(dir?: string): string | undefined {
    return Workspace.resolveListPath(Instance.workspace, dir)
  }

  export async function list(dir?: string) {
    const exclude = [".git", ".DS_Store"]
    const workspace = Instance.workspace
    const multi = workspace.folders.length > 1

    // Multi-root: an empty path returns each folder as a top-level node (absolute paths avoid collisions)
    if (multi && resolveListDir(dir) === undefined) {
      return workspace.folders
        .map((f): Node => ({
          name: f.name,
          path: f.path,
          absolute: f.path,
          type: "directory",
          ignored: false,
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    }

    const resolved = resolveListDir(dir) ?? Instance.directory

    // Directories outside the workspace may be listed, like File.read

    const folder = Workspace.resolveFolder(workspace, resolved)
    const worktree = folder?.worktree && folder.worktree !== "/" ? folder.worktree : Instance.worktree
    let ignored = (_: string) => false
    if (worktree !== "/") {
      const ig = ignore()
      const gitignore = path.join(worktree, ".gitignore")
      if (await Filesystem.isFile(gitignore)) {
        ig.add(await Filesystem.readText(gitignore))
      }
      const ignoreFile = path.join(worktree, ".ignore")
      if (await Filesystem.isFile(ignoreFile)) {
        ig.add(await Filesystem.readText(ignoreFile))
      }
      ignored = ig.ignores.bind(ig)
    }

    const nodes: Node[] = []
    for (const entry of await fs.promises
      .readdir(resolved, {
        withFileTypes: true,
      })
      .catch(() => [])) {
      if (exclude.includes(entry.name)) continue
      const fullPath = path.join(resolved, entry.name)
      // Multi-root children use absolute paths so the UI and the next list call are unambiguous
      const entryPath = multi ? fullPath : path.relative(Instance.directory, fullPath)
      const type = entry.isDirectory() ? "directory" : "file"
      const ignoreRel = path.relative(folder?.path ?? Instance.directory, fullPath)
      nodes.push({
        name: entry.name,
        path: entryPath,
        absolute: fullPath,
        type,
        ignored: ignored(type === "directory" ? ignoreRel + "/" : ignoreRel),
      })
    }
    return nodes.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })
  }

  export async function search(input: { query: string; limit?: number; dirs?: boolean; type?: "file" | "directory" }) {
    const query = input.query.trim()
    const limit = input.limit ?? 100
    const kind = input.type ?? (input.dirs === false ? "file" : "all")
    log.info("search", { query, kind })

    const result = await state().then((x) => x.files())

    const hidden = (item: string) => {
      const normalized = item.replaceAll("\\", "/").replace(/\/+$/, "")
      return normalized.split("/").some((p) => p.startsWith(".") && p.length > 1)
    }
    const preferHidden = query.startsWith(".") || query.includes("/.")
    const sortHiddenLast = (items: string[]) => {
      if (preferHidden) return items
      const visible: string[] = []
      const hiddenItems: string[] = []
      for (const item of items) {
        const isHidden = hidden(item)
        if (isHidden) hiddenItems.push(item)
        if (!isHidden) visible.push(item)
      }
      return [...visible, ...hiddenItems]
    }
    if (!query) {
      if (kind === "file") return result.files.slice(0, limit)
      if (kind === "directory") return sortHiddenLast(result.dirs.toSorted()).slice(0, limit)
      return sortHiddenLast([...result.files, ...result.dirs.toSorted()]).slice(0, limit)
    }

    const items =
      kind === "file" ? result.files : kind === "directory" ? result.dirs : [...result.files, ...result.dirs]

    const searchLimit = kind === "directory" && !preferHidden ? limit * 20 : limit
    const sorted = fuzzysort.go(query, items, { limit: searchLimit, threshold: 0 }).map((r) => r.target)
    const output = kind === "directory" ? sortHiddenLast(sorted).slice(0, limit) : sorted

    log.info("search", { query, kind, results: output.length })
    return output
  }
}
