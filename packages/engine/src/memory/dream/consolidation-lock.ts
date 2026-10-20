import path from "path"
import { mkdir, readFile, stat, unlink, utimes, writeFile } from "fs/promises"
import { Session } from "../../session"
import { Log } from "@merakcode/log/logger"
import { isProcessRunning } from "../../util/process"
import { DreamPath } from "./path"

const log = Log.create({ service: "memory.dream.lock" })

/** A lock older than 1h is stale even if its PID is alive, which guards against PID reuse */
const HOLDER_STALE_MS = 60 * 60 * 1000

/**
 * The lock file mtime is lastConsolidatedAt; returns 0 when there is no lock file.
 * Costs one stat per turn.
 */
export async function readLastConsolidatedAt(): Promise<number> {
  try {
    return (await stat(DreamPath.lockFile())).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Acquires the lock by writing our PID, which sets mtime to now. Returns the pre-acquire mtime for rollback,
 * or null when the lock is held or a race was lost.
 *
 *   success -> nothing to do; mtime stays at now, advancing lastConsolidatedAt
 *   failure -> rollbackConsolidationLock(priorMtime) restores the mtime
 *   crash   -> mtime stays put with a dead PID, and the next process reclaims the lock
 *
 * When two reclaimers write at once, the last writer wins; the loser rereads the file, sees another PID and backs off.
 */
export async function tryAcquireConsolidationLock(): Promise<number | null> {
  const lockPath = DreamPath.lockFile()

  let mtimeMs: number | undefined
  let holderPid: number | undefined
  try {
    const [s, raw] = await Promise.all([stat(lockPath), readFile(lockPath, "utf8")])
    mtimeMs = s.mtimeMs
    const parsed = parseInt(raw.trim(), 10)
    holderPid = Number.isFinite(parsed) ? parsed : undefined
  } catch {
    // ENOENT: no previous lock
  }

  if (mtimeMs !== undefined && Date.now() - mtimeMs < HOLDER_STALE_MS) {
    if (holderPid !== undefined && isProcessRunning(holderPid)) {
      log.info("lock held by live process", {
        pid: holderPid,
        ageSec: Math.round((Date.now() - mtimeMs) / 1000),
      })
      return null
    }
    // The PID is dead or unparsable, so reclaim the lock
  }

  // The memory directory may not exist yet on the first consolidation
  await mkdir(path.dirname(lockPath), { recursive: true }).catch(() => undefined)
  await writeFile(lockPath, String(process.pid))

  // Two reclaimers may write at once; the last writer owns the lock
  const verify = await readFile(lockPath, "utf8").catch(() => "")
  if (parseInt(verify.trim(), 10) !== process.pid) return null

  return mtimeMs ?? 0
}

/**
 * Rolls back after a failed fork: restores the pre-acquire mtime and clears the PID body, otherwise our still
 * running process would look like the holder. A priorMtime of 0 unlinks the file to restore the no-lock state.
 */
export async function rollbackConsolidationLock(priorMtime: number): Promise<void> {
  const lockPath = DreamPath.lockFile()
  try {
    if (priorMtime === 0) {
      await unlink(lockPath)
      return
    }
    await writeFile(lockPath, "")
    const t = priorMtime / 1000 // utimes takes seconds
    await utimes(lockPath, t, t)
  } catch (error) {
    log.warn("rollback failed - next trigger delayed to minHours", { error })
  }
}

/**
 * IDs of non-child sessions updated since sinceMs, filtered by Session.Info.time.updated from Session.list().
 *
 * The caller excludes the current session. This only feeds a skip gate, so undercounting worktree sessions is safe.
 */
export async function listSessionsTouchedSince(sinceMs: number): Promise<string[]> {
  const result: string[] = []
  for await (const session of Session.list()) {
    if (session.parentID) continue // skip child sessions
    if (session.time.updated <= sinceMs) continue
    result.push(session.id)
  }
  return result
}
