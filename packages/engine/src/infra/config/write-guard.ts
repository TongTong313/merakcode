import path from "path"
import fs from "fs/promises"
import { Filesystem } from "@merakcode/util/filesystem"
import { setTimeout as delay } from "node:timers/promises"

/** Cross-process config writes: snapshot comparison and self-write records, so config watch skips our writes */
export namespace ConfigWriteGuard {
  export type Snapshot = { mtimeMs: number; size: number; hash: string }

  type SelfWrite = { hash: string; expires: number }

  const selfWrites = new Map<string, SelfWrite>()
  const SELF_TTL_MS = 3_000
  const MAX_RETRIES = 8

  export function maxRetries() {
    return MAX_RETRIES
  }

  /** Lowercase drive letter and forward slashes, so paths compare equal across platforms */
  export function normalizePath(filepath: string) {
    return filepath.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d: string) => `${d.toLowerCase()}:`)
  }

  function hash(text: string) {
    let h = 2166136261
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return (h >>> 0).toString(16)
  }

  export async function snapshot(filepath: string): Promise<Snapshot> {
    if (!(await Filesystem.isFile(filepath))) return { mtimeMs: 0, size: 0, hash: "" }
    const stat = await fs.stat(filepath)
    const text = await Filesystem.readText(filepath)
    return { mtimeMs: stat.mtimeMs ?? 0, size: stat.size, hash: hash(text) }
  }

  export async function changed(before: Snapshot, filepath: string) {
    const after = await snapshot(filepath)
    return after.mtimeMs !== before.mtimeMs || after.size !== before.size || after.hash !== before.hash
  }

  /** Keep the replacement atomic, rechecking external edits after a temporary Windows sharing violation. */
  export async function replace(temp: string, filepath: string, before: Snapshot): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      if (await changed(before, filepath)) return false
      try {
        await fs.rename(temp, filepath)
        return true
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (process.platform !== "win32" || attempt === 5 || !["EPERM", "EBUSY", "EACCES"].includes(code ?? ""))
          throw error
        await delay(10 * 2 ** attempt)
      }
    }
  }

  /** Records a write by this process so the watch callback skips it instead of looping */
  export function registerSelfWrite(filepath: string, content: string) {
    selfWrites.set(normalizePath(filepath), { hash: hash(content), expires: Date.now() + SELF_TTL_MS })
  }

  /** For a change seen by watch or polling: true (and consumed) if it is content this process just wrote */
  export function consumeSelfWrite(filepath: string, content?: string) {
    const key = normalizePath(filepath)
    const entry = selfWrites.get(key)
    if (!entry || Date.now() > entry.expires) {
      selfWrites.delete(key)
      return false
    }
    if (content !== undefined && hash(content) !== entry.hash) return false
    selfWrites.delete(key)
    return true
  }

  /** Whether a changed path is the watched config file */
  export function matchesConfigPath(changed: string, configFile: string) {
    return normalizePath(changed) === normalizePath(configFile)
  }

  export function configDir(configFile: string) {
    return path.dirname(configFile)
  }
}
