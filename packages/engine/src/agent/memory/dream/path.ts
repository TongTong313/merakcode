import path from "path"
import { MemoryPath } from "../path"

/**
 * AutoDream (memory consolidation) paths.
 *
 * The lock file lives inside the memory directory, so it is isolated per projectKey and stays writable even when the
 * memory path comes from an override whose parent directory is not writable.
 *
 * The lock file mtime is lastConsolidatedAt, so one stat reads both the lock state and the timestamp; see
 * consolidation-lock.ts.
 */
export namespace DreamPath {
  const LOCK_FILE = ".consolidate-lock"

  export function lockFile() {
    return path.join(MemoryPath.directory(), LOCK_FILE)
  }
}
