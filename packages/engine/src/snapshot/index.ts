import path from "path"
import { constants } from "fs"
import fs from "fs/promises"
import { Log } from "@merakcode/log/logger"
import { isProcessRunning } from "../util/process"
import { Process } from "@merakcode/util/process"
import { Flag } from "../flag/flag"
import { Global } from "../global"
import z from "zod"
import { Instance } from "../project/instance"
import { Scheduler } from "../scheduler"
import { createTwoFilesPatch, diffLines } from "diff"
import { Filesystem } from "@merakcode/util/filesystem"

export namespace Snapshot {
  const log = Log.create({ service: "snapshot" })
  const hour = 60 * 60 * 1000
  const prune = "7.days"

  /** A session's backup directory may be removed once the session has been inactive this long */
  const SESSION_ACTIVE_WINDOW = 7 * 24 * hour
  let cleanupRunning = false

  // sessionID -> active backupID, set by the latest track()
  const activeBackups = new Map<string, string>()

  export function init() {
    Scheduler.register({
      id: "snapshot.cleanup",
      interval: 24 * hour,
      run: cleanup,
      scope: "instance",
    })
  }

  /**
   * Cleans up legacy git snapshot repositories and file backups.
   * Backup directories of sessions inactive longer than SESSION_ACTIVE_WINDOW are removed. If the session has an
   * undoRedo stack, it is discarded first so hidden messages are deleted and references cleared.
   */
  export async function cleanup() {
    if (cleanupRunning) {
      log.debug("cleanup skipped: already running")
      return
    }
    cleanupRunning = true

    const lockPath = path.join(backupRoot(), ".cleanup.lock")
    let lockAcquired = false

    try {
      await fs.mkdir(backupRoot(), { recursive: true })
      lockAcquired = await acquireCleanupLock(lockPath)
      if (!lockAcquired) {
        log.debug("cleanup skipped: lock held by another process")
        return
      }

      // Legacy git snapshot repository
      if (Instance.project.vcs === "git" && Flag.MERAKCODE_CLIENT !== "acp") {
        const { Config } = await import("../config/config")
        const cfg = await Config.get()
        if (cfg.snapshot !== false) {
          const git = gitdir()
          const exists = await fs
            .stat(git)
            .then(() => true)
            .catch(() => false)
          if (exists) {
            const result = await Process.run(
              ["git", "--git-dir", git, "--work-tree", Instance.worktree, "gc", `--prune=${prune}`],
              { cwd: Instance.directory, nothrow: true },
            )
            if (result.exitCode !== 0) {
              log.warn("cleanup git failed", {
                exitCode: result.exitCode,
                stderr: result.stderr.toString(),
              })
            } else {
              log.info("cleanup git", { prune })
            }
          }
        }
      }

      // File backups, skipping sessions that are still active
      // Dynamic import avoids a circular dependency
      const [{ SessionStore }, { SessionUndoRedo }] = await Promise.all([
        import("../session/store"),
        import("../session/undo-redo"),
      ])

      for (const sessionDir of await fs.readdir(backupRoot())) {
        const sessionPath = path.join(backupRoot(), sessionDir)
        const sessionStat = await fs.stat(sessionPath).catch(() => null)
        if (!sessionStat?.isDirectory()) continue
        if (sessionDir.startsWith(".")) continue

        // Looked up in every project, so a process with a different project id does not delete another process's
        // backups; damaged session data counts as present
        let session: ReturnType<typeof SessionStore.find>
        try {
          session = SessionStore.find(sessionDir)
        } catch {
          continue
        }

        if (!session) {
          // Only delete as orphaned once no project has this session
          await fs.rm(sessionPath, { recursive: true, force: true })
          log.info("cleanup orphaned backup dir", { sessionID: sessionDir })
          continue
        }

        const lastUpdated = session.time?.updated ?? session.time?.created ?? 0
        if (Date.now() - lastUpdated <= SESSION_ACTIVE_WINDOW) {
          continue
        }

        // Expired: discard undo/redo state before deleting
        if (session.undoRedo?.stack?.length) {
          log.info("discard undoRedo before cleanup", { sessionID: sessionDir })
          await SessionUndoRedo.discard({ sessionID: sessionDir, projectID: session.projectID })
        }

        await fs.rm(sessionPath, { recursive: true, force: true })
        log.info("cleanup expired backup dir", { sessionID: sessionDir, lastUpdated })
      }
    } finally {
      cleanupRunning = false
      if (lockAcquired) {
        await fs.unlink(lockPath).catch(() => {})
      }
    }
  }

  /**
   * Starts a new backup batch and returns its backupID (a timestamp string).
   * Returns an empty string when cfg.snapshot === false.
   */
  export async function track(sessionID: string): Promise<string> {
    const { Config } = await import("../config/config")
    const cfg = await Config.get()
    if (cfg.snapshot === false) return ""

    const backupID = Date.now().toString()
    activeBackups.set(sessionID, backupID)

    const backupDir = getBackupDir(sessionID, backupID)
    await fs.mkdir(backupDir, { recursive: true })

    log.info("track", { backupID, sessionID })
    return backupID
  }

  /**
   * Writes the current workspace state of the files into the active backup (usually the one step-finish just
   * tracked).
   *
   * SessionSummary.computeDiff / diffFull compare the step-start and step-finish backups, not a backup against the
   * workspace. If the finish backup is empty, new files are skipped (missing on both sides) and modified files look
   * deleted, so session.summary / session.diff report 0 lines. The processor should call this after patch() returns
   * the step's files.
   */
  export async function captureWorkspaceFiles(files: string[], sessionID: string) {
    for (const file of files) {
      await trackFile(file, sessionID)
    }
  }

  /**
   * Called before a tool modifies a file: copies the original file into the active backup directory.
   * Each file is backed up only once per backup (the first time).
   */
  export async function trackFile(filePath: string, sessionID: string) {
    const backupID = activeBackups.get(sessionID)
    if (!backupID) {
      log.warn("trackFile called without active backup", { sessionID, filePath })
      return
    }

    const encodedPath = toBackupPath(filePath)
    const backupDir = getBackupDir(sessionID, backupID)
    const destPath = joinBackupPath(backupDir, encodedPath)

    const alreadyBacked = await fs
      .stat(destPath)
      .then(() => true)
      .catch(() => false)
    const alreadyMarked = await fs
      .stat(destPath + ".__deleted__")
      .then(() => true)
      .catch(() => false)
    if (alreadyBacked || alreadyMarked) return

    await fs.mkdir(path.dirname(destPath), { recursive: true })

    const exists = await Filesystem.isFile(filePath)
    if (exists) {
      await fs.copyFile(filePath, destPath)
      log.debug("trackFile backed up", { filePath, backupID })
    } else {
      // The file did not exist yet: write a deletion marker
      await fs.writeFile(destPath + ".__deleted__", "")
      log.debug("trackFile marked deleted", { filePath, backupID })
    }
  }

  /**
   * Called on undo: backs up the current workspace state of the given files, so redo can restore the state from
   * before the undo.
   */
  export async function backupCurrentFiles(backupID: string, sessionID: string, files: string[]) {
    const backupDir = getBackupDir(sessionID, backupID)
    await fs.mkdir(backupDir, { recursive: true })

    const mtimeMap: Record<string, number | null> = {}

    for (const relativePath of files) {
      const worktreePath = resolveWorktreeFile(relativePath)
      const encodedPath = toBackupPath(worktreePath)
      const destPath = joinBackupPath(backupDir, encodedPath)

      // Never overwrite an existing backup
      const exists = await fs
        .stat(destPath)
        .then(() => true)
        .catch(() => false)
      const marked = await fs
        .stat(destPath + ".__deleted__")
        .then(() => true)
        .catch(() => false)
      if (exists || marked) continue

      // This backup only serves redo, so it is best-effort: one failing file (e.g. locked) only warns and must not
      // block the undo, which has priority.
      try {
        await fs.mkdir(path.dirname(destPath), { recursive: true })

        const fileExists = await Filesystem.isFile(worktreePath)
        if (fileExists) {
          await fs.copyFile(worktreePath, destPath)
          const stat = await fs.stat(worktreePath)
          mtimeMap[encodedPath] = stat.mtime.getTime()
        } else {
          await fs.writeFile(destPath + ".__deleted__", "")
          mtimeMap[encodedPath] = null
        }
      } catch (e) {
        log.warn("backupCurrentFiles failed (redo backup, best-effort)", { file: worktreePath, error: String(e) })
      }
    }

    // mtimes let checkManualChanges detect manual edits
    if (Object.keys(mtimeMap).length > 0) {
      await fs.writeFile(path.join(backupDir, ".__mtime__.json"), JSON.stringify(mtimeMap))
    }
  }

  /**
   * Returns workspace files modified manually since the backup, by comparing the mtime recorded at backup time with
   * the current mtime.
   */
  export async function checkManualChanges(backupID: string, sessionID: string): Promise<string[]> {
    const backupDir = getBackupDir(sessionID, backupID)
    const mtimePath = path.join(backupDir, ".__mtime__.json")
    const mtimeMap: Record<string, number | null> = await Filesystem.readJson(mtimePath).catch(() => ({}))

    const modified: string[] = []
    for (const [encodedPath, backupMtime] of Object.entries(mtimeMap)) {
      if (backupMtime === null) continue

      const worktreePath = fromBackupPath(encodedPath)
      const currentStat = await fs.stat(worktreePath).catch(() => null)
      if (!currentStat) {
        modified.push(worktreePath)
        continue
      }

      if (currentStat.mtime.getTime() !== backupMtime) {
        modified.push(worktreePath)
      }
    }

    return modified
  }

  export const Patch = z.object({
    backupID: z.string(),
    files: z.string().array(),
    additions: z.number().default(0),
    deletions: z.number().default(0),
  })
  export type Patch = z.infer<typeof Patch>

  /**
   * Lists the files in a backup and counts additions/deletions between the backed-up version and the current
   * workspace version.
   */
  export async function patch(backupID: string, sessionID: string): Promise<Patch> {
    const backupDir = getBackupDir(sessionID, backupID)
    const files: string[] = []
    let additions = 0
    let deletions = 0

    for await (const backupPath of walk(backupDir)) {
      const backupRelative = path.relative(backupDir, backupPath)
      if (backupRelative.endsWith(".__deleted__")) {
        const realBackupRelative = backupRelative.replace(/\.__deleted__$/, "")
        const worktreePath = fromBackupPath(realBackupRelative)
        files.push(worktreePath)
        // The file was created: every current line counts as an addition
        const currentContent = await Filesystem.readText(worktreePath).catch(() => "")
        additions += currentContent.split("\n").length
      } else {
        const worktreePath = fromBackupPath(backupRelative)
        files.push(worktreePath)
        const backupContent = await Filesystem.readText(backupPath).catch(() => "")
        const currentContent = await Filesystem.readText(worktreePath).catch(() => "")
        for (const change of diffLines(backupContent, currentContent)) {
          if (change.added) additions += change.count || 0
          if (change.removed) deletions += change.count || 0
        }
      }
    }

    return { backupID, files, additions, deletions }
  }

  /**
   * Restores every file in the backup to the workspace.
   * Returns the deduplicated relative paths of the restored files.
   */
  export async function restore(backupID: string, sessionID: string): Promise<string[]> {
    log.info("restore", { backupID, sessionID })
    const backupDir = getBackupDir(sessionID, backupID)
    const dirExists = await fs
      .stat(backupDir)
      .then(() => true)
      .catch(() => false)
    if (!dirExists) {
      log.warn("backup not found", { backupID, sessionID })
      return []
    }

    const restoredFiles: string[] = []

    for await (const backupPath of walk(backupDir)) {
      const backupRelative = path.relative(backupDir, backupPath)

      if (backupRelative.endsWith(".__deleted__")) {
        const realBackupRelative = backupRelative.replace(/\.__deleted__$/, "")
        const worktreePath = fromBackupPath(realBackupRelative)
        await fs.unlink(worktreePath).catch(() => {})
        restoredFiles.push(realBackupRelative)
        log.info("restore deleted", { file: worktreePath })
      } else if (!backupRelative.startsWith(".__mtime__")) {
        const worktreePath = fromBackupPath(backupRelative)
        await fs.mkdir(path.dirname(worktreePath), { recursive: true })
        await fs.copyFile(backupPath, worktreePath)
        restoredFiles.push(backupRelative)
        log.debug("restore copied", { file: worktreePath })
      }
    }

    return [...new Set(restoredFiles)]
  }

  /**
   * Reverts files one by one from a list of patches.
   * Kept for older callers; undo/redo uses restore(backupID).
   */
  export async function revert(patches: Patch[], sessionID?: string): Promise<{ failed: string[] }> {
    const files = new Set<string>()
    // A failing file (locked, no permission, a directory, ...) does not abort the revert: the remaining files are
    // still reverted, and failures are returned in `failed` instead of being silently reported as success.
    const failed: string[] = []
    for (const item of patches) {
      for (const file of item.files) {
        if (files.has(file)) continue
        files.add(file)
        log.info("reverting", { file, backupID: item.backupID })

        try {
          if (sessionID) {
            const backupDir = getBackupDir(sessionID, item.backupID)
            const encodedPath = toBackupPath(file)
            const backupPath = joinBackupPath(backupDir, encodedPath)
            const deletedPath = backupPath + ".__deleted__"

            if (await Filesystem.isFile(deletedPath)) {
              // On Windows, Node's unlink clears FILE_ATTRIBUTE_READONLY before deleting. Check write access first so a
              // read-only file ends up in `failed`, like Win32 DeleteFile returning ACCESS_DENIED.
              await fs.access(file, constants.W_OK)
              await fs.unlink(file)
              log.info("revert deleted", { file })
            } else if (await Filesystem.isFile(backupPath)) {
              await fs.mkdir(path.dirname(file), { recursive: true })
              await fs.copyFile(backupPath, file)
              log.info("revert copied", { file })
            } else {
              log.warn("revert backup not found", { file, backupID: item.backupID })
            }
          } else {
            // Without a sessionID, fall back to the legacy git snapshot used by older sessions
            const git = ["git", "--git-dir", gitdir(), "--work-tree", Instance.worktree]
            const result = await Process.run([...git, "checkout", item.backupID, "--", file], {
              cwd: Instance.worktree,
              nothrow: true,
            })
            if (result.exitCode !== 0) {
              const relativePath = path.relative(Instance.worktree, file)
              const checkTree = await Process.run([...git, "ls-tree", item.backupID, "--", relativePath], {
                cwd: Instance.worktree,
                nothrow: true,
              })
              if (checkTree.exitCode === 0 && checkTree.text().trim()) {
                log.info("file existed in snapshot but checkout failed, keeping", { file })
              } else {
                log.info("file did not exist in snapshot, deleting", { file })
                await fs.unlink(file)
              }
            }
          }
        } catch (e: any) {
          // ENOENT: the file to delete is already gone, which counts as success
          if (e?.code === "ENOENT") {
            log.info("revert target already gone", { file })
          } else {
            log.warn("revert file failed", { file, error: String(e) })
            failed.push(file)
          }
        }
      }
    }
    return { failed }
  }

  /**
   * Returns the diff text between a backup and the current workspace.
   */
  export async function diff(backupID: string, sessionID: string): Promise<string> {
    const backupDir = getBackupDir(sessionID, backupID)
    let result = ""

    for await (const backupPath of walk(backupDir)) {
      const backupRelative = path.relative(backupDir, backupPath)
      if (backupRelative.endsWith(".__deleted__")) {
        const realBackupRelative = backupRelative.replace(/\.__deleted__$/, "")
        const worktreePath = fromBackupPath(realBackupRelative)
        const currentContent = await Filesystem.readText(worktreePath).catch(() => "")
        result += createTwoFilesPatch(realBackupRelative, realBackupRelative, "", currentContent) + "\n"
      } else {
        const worktreePath = fromBackupPath(backupRelative)
        const backupContent = await Filesystem.readText(backupPath).catch(() => "")
        const currentContent = await Filesystem.readText(worktreePath).catch(() => "")
        if (backupContent !== currentContent) {
          result += createTwoFilesPatch(backupRelative, backupRelative, backupContent, currentContent) + "\n"
        }
      }
    }

    return result.trim()
  }

  export const FileDiff = z
    .object({
      file: z.string(),
      before: z.string(),
      after: z.string(),
      additions: z.number(),
      deletions: z.number(),
      status: z.enum(["added", "deleted", "modified"]).optional(),
    })
    .meta({
      ref: "FileDiff",
    })
  export type FileDiff = z.infer<typeof FileDiff>

  /**
   * Compares two backups. Only files present in at least one backup are compared; other files count as unchanged.
   */
  export async function diffFull(from: string, to: string, sessionID: string): Promise<FileDiff[]> {
    const fromDir = getBackupDir(sessionID, from)
    const toDir = getBackupDir(sessionID, to)
    const result: FileDiff[] = []
    const allFiles = new Set<string>()

    // Files of both backups, without the .__deleted__ suffix
    for await (const p of walk(fromDir)) {
      allFiles.add(path.relative(fromDir, p).replace(/\.__deleted__$/, ""))
    }
    for await (const p of walk(toDir)) {
      allFiles.add(path.relative(toDir, p).replace(/\.__deleted__$/, ""))
    }

    for (const relativePath of allFiles) {
      const fromFile = await readBackupFile(fromDir, relativePath)
      const toFile = await readBackupFile(toDir, relativePath)

      if (!fromFile.exists && !toFile.exists) continue
      if (fromFile.content === toFile.content && fromFile.exists === toFile.exists) continue

      let status: "added" | "deleted" | "modified"
      if (!fromFile.exists && toFile.exists) status = "added"
      else if (fromFile.exists && !toFile.exists) status = "deleted"
      else status = "modified"

      const diff = diffLines(fromFile.content, toFile.content)
      let additions = 0
      let deletions = 0
      for (const change of diff) {
        if (change.added) additions += change.count || 0
        if (change.removed) deletions += change.count || 0
      }

      const worktreePath = fromBackupPath(relativePath)

      result.push({
        file: worktreePath,
        before: fromFile.content,
        after: toFile.content,
        additions,
        deletions,
        status,
      })
    }

    return result
  }

  /**
   * Every file in the backups of these sessions, ordered by backup time (the backupID is the creation timestamp).
   * A file's earliest entry holds its content before the agent first changed it; read() returns the backed-up
   * content, or undefined if the file did not exist then.
   */
  export async function history(sessionIDs: string[]) {
    const result: { file: string; time: number; read: () => Promise<Buffer | undefined> }[] = []
    for (const sessionID of sessionIDs) {
      const root = path.join(backupRoot(), sessionID)
      for (const backupID of await fs.readdir(root).catch(() => [] as string[])) {
        const time = Number(backupID)
        if (!Number.isFinite(time)) continue
        const dir = path.join(root, backupID)
        for await (const item of walk(dir)) {
          const relative = path.relative(dir, item)
          if (relative.startsWith(".__mtime__")) continue
          const deleted = relative.endsWith(".__deleted__")
          result.push({
            file: fromBackupPath(deleted ? relative.slice(0, -".__deleted__".length) : relative),
            time,
            read: async () => (deleted ? undefined : fs.readFile(item)),
          })
        }
      }
    }
    return result.toSorted((a, b) => a.time - b.time)
  }

  /**
   * Encodes an absolute workspace path as a safe relative path inside the backup directory.
   * Files outside the workspace keep their full path under the __external__ prefix.
   *
   * Windows: across drives (or worktree="/" vs "C:\..."), `path.relative` falls back to the absolute path, which does
   * not start with "..", so `isAbsolute` must exclude it too. Otherwise it is treated as a worktree-relative path and
   * `path.join(backupDir, x)` builds an invalid path such as `C:\snap\...\C:\Users\...`, and mkdir fails with ENOENT.
   * External paths also drop the drive colon (`C:\` → `__drive_C__/`) so the result contains no `:`.
   * `path.join(worktree="/", "d:\\...")` can yield `\d:\...`, so leading slashes are stripped before the drive is
   * replaced.
   */
  function toBackupPath(absolutePath: string): string {
    const resolved = resolveWorktreeFile(absolutePath)
    // With worktree="/", path.relative("/", "D:\\foo") drops the drive letter, so paths on another drive (or under
    // the global placeholder worktree) must go to __external__ before relativizing.
    if (isWindowsAbsolute(resolved) && !sameWindowsDrive(resolved, Instance.worktree)) {
      return encodeExternal(resolved)
    }
    const relativePath = path.relative(Instance.worktree, resolved)
    if (!relativePath.startsWith("..") && !path.isAbsolute(relativePath) && !isWindowsAbsolute(relativePath)) {
      return relativePath
    }
    return encodeExternal(resolved)
  }

  function encodeExternal(resolved: string): string {
    const stripped = resolved.replace(/^[/\\]+/, "")
    const safe = stripped.replace(/^([A-Za-z]):[/\\]/, "__drive_$1__/").replace(/\\/g, "/")
    return path.posix.join("__external__", safe)
  }

  function sameWindowsDrive(file: string, worktree: string): boolean {
    const fileDrive = file.match(/^[/\\]*([A-Za-z]):/)
    const treeDrive = worktree.match(/^[/\\]*([A-Za-z]):/)
    if (!fileDrive || !treeDrive) return false
    return fileDrive[1].toLowerCase() === treeDrive[1].toLowerCase()
  }

  /**
   * Decodes a relative path inside the backup directory to an absolute workspace path.
   * On Windows `__drive_C__\...` becomes `C:\...` again, mirroring toBackupPath.
   */
  function fromBackupPath(backupRelative: string): string {
    const normalized = backupRelative.replace(/\\/g, "/")
    if (normalized.startsWith("__external__/")) {
      const withoutPrefix = normalized.slice("__external__/".length)
      const driveMatch = withoutPrefix.match(/^__drive_([A-Za-z])__\/(.*)$/)
      if (driveMatch) return path.resolve(`${driveMatch[1]}:${path.sep}${driveMatch[2].replace(/\//g, path.sep)}`)
      return path.resolve("/", withoutPrefix)
    }
    return path.join(Instance.worktree, backupRelative)
  }

  /** Treats `\d:\foo` and `d:\foo` as absolute so they are never joined onto worktree="/". */
  function isWindowsAbsolute(file: string): boolean {
    return /^[/\\]*[A-Za-z]:[/\\]/.test(file)
  }

  function resolveWorktreeFile(file: string): string {
    if (isWindowsAbsolute(file)) return file.replace(/^[/\\]+(?=[A-Za-z]:)/, "")
    if (path.isAbsolute(file)) return file
    return path.join(Instance.worktree, file)
  }

  /** Joins the path segment by segment, so a leftover drive letter in the encoded path cannot drop the prefix. */
  function joinBackupPath(backupDir: string, encodedPath: string): string {
    const parts = encodedPath
      .replace(/\\/g, "/")
      .split("/")
      .filter((part) => part.length > 0)
    return path.join(backupDir, ...parts)
  }

  /** File backups, one directory per session and one subdirectory per backupID */
  function backupRoot() {
    return path.join(Global.Path.data, "backup")
  }

  function getBackupDir(sessionID: string, backupID: string): string {
    return path.join(backupRoot(), sessionID, backupID)
  }

  /** Deletes every backup of a session */
  export async function drop(sessionID: string) {
    await fs.rm(path.join(backupRoot(), sessionID), { recursive: true, force: true })
  }

  function gitdir(): string {
    const project = Instance.project
    return path.join(Global.Path.data, "snapshot", project.id)
  }

  /**
   * Tries to acquire the cleanup file lock.
   * The lock file holds `{pid},{timestamp}`, to detect concurrent processes and stale locks.
   */
  async function acquireCleanupLock(lockPath: string): Promise<boolean> {
    try {
      const lockData = await Filesystem.readText(lockPath)
      const [pid, timestamp] = lockData.split(",").map(Number)

      // A lock older than 6 hours can be taken over
      if (Date.now() - (timestamp || 0) > 6 * hour) {
        await fs.writeFile(lockPath, `${process.pid},${Date.now()}`)
        return true
      }

      // Not expired: take it over only if the holder process is dead
      if (pid && pid !== process.pid) {
        if (isProcessRunning(pid)) return false
        await fs.writeFile(lockPath, `${process.pid},${Date.now()}`)
        return true
      }

      return pid === process.pid
    } catch {
      // No lock file yet
      await fs.writeFile(lockPath, `${process.pid},${Date.now()}`)
      return true
    }
  }

  async function* walk(dir: string): AsyncGenerator<string> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries as { name: string; isDirectory(): boolean }[]) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        yield* walk(fullPath)
      } else {
        yield fullPath
      }
    }
  }

  async function readBackupFile(
    backupDir: string,
    relativePath: string,
  ): Promise<{ exists: boolean; content: string }> {
    const filePath = joinBackupPath(backupDir, relativePath)
    const deletedPath = filePath + ".__deleted__"

    if (await Filesystem.isFile(deletedPath)) {
      return { exists: false, content: "" }
    }

    if (await Filesystem.isFile(filePath)) {
      const content = await Filesystem.readText(filePath)
      return { exists: true, content }
    }

    return { exists: false, content: "" }
  }
}
