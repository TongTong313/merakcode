import * as fs from "fs/promises"
import * as path from "path"
import { failure } from "@merakcode/log"
import { Log } from "@merakcode/log/logger"
import { Filesystem } from "@merakcode/util/filesystem"

/**
 * File writes via a temp file in the same directory plus rename, so readers see either the full old or new version.
 *
 * - The temp file lives next to the target so rename stays within one file system.
 * - A symlink target is resolved first, otherwise rename would replace the link with a regular file.
 * - The original permission bits are kept, otherwise an executable script (755) would become 644.
 */
export namespace Atomic {
  const log = Log.create({ service: "file.atomic" })

  /**
   * Rename error codes where falling back to a direct overwrite is fine: target in use (common on Windows) or the
   * directory is a mount point
   */
  const RECOVERABLE = new Set(["EPERM", "EBUSY", "EACCES", "EXDEV"])

  // Counter in the temp name. With only pid + timestamp, concurrent writes to one target in the same millisecond would
  // share a temp file and overwrite each other, producing exactly the partial content atomic writes should prevent.
  let seq = 0

  function recoverable(err: unknown) {
    const code = (err as { code?: string } | undefined)?.code
    return code !== undefined && RECOVERABLE.has(code)
  }

  export async function write(filepath: string, content: string | Uint8Array) {
    const started = Date.now()
    log.info("atomic write started")
    try {
      // Write through symlinks to the real file; realpath fails for a missing file, which is then its own target
      const target = await fs.realpath(filepath).catch(() => filepath)
      const dir = path.dirname(target)
      await fs.mkdir(dir, { recursive: true })
      // Permission bits only (including setuid/setgid/sticky); file type bits must not reach chmod
      const mode = await fs
        .stat(target)
        .then((s) => s.mode & 0o7777)
        .catch(() => undefined)
      // Temp file `.<name>.mc-tmp-<pid>-<time>-<seq>` next to the target
      const tmp = path.join(dir, `.${path.basename(target)}.mc-tmp-${process.pid}-${Date.now()}-${seq++}`)
      try {
        await Filesystem.write(tmp, content)
        if (mode !== undefined) await fs.chmod(tmp, mode)
        await fs.rename(tmp, target)
      } catch (error) {
        await fs.rm(tmp, { force: true }).catch((error: unknown) => {
          log.warn("atomic temporary cleanup failed", failure(error))
        })
        if (!recoverable(error)) throw error
        log.warn("atomic rename failed, falling back to direct write", { ...failure(error) })
        await Filesystem.write(target, content)
      }
      log.info("atomic write completed", { duration: Date.now() - started })
    } catch (error) {
      log.error("atomic write failed", { duration: Date.now() - started, ...failure(error) })
      throw error
    }
  }
}
