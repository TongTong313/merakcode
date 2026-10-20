import path from "path"
import { PermissionNext } from "../permission/next"
import { MemoryPath } from "./path"
import { MEMORY_TYPES } from "./types"
import { MemorySecretScan } from "./secret-scan"

export namespace MemoryAccess {
  export function root() {
    return path.resolve(MemoryPath.directory())
  }

  /**
   * Rejects malformed paths (null bytes, UNC paths, bare Windows drive roots) to prevent path traversal.
   *
   * The memory directory derives from Instance.worktree, not from project config, so a malicious repository
   * cannot redirect it. This check is only a defensive fallback.
   */
  function isUnsafePath(filePath: string): boolean {
    if (filePath.includes("\0")) return true // null byte injection
    if (/^[\\/]{2}/.test(filePath)) return true // UNC path (\\host\share or //host/share)
    if (/^[A-Za-z]:$/.test(filePath)) return true // bare Windows drive root (e.g. C:)
    return false
  }

  export function isReadablePath(filePath: string | undefined) {
    if (!filePath) return false
    if (isUnsafePath(filePath)) return false
    const base = root()
    const target = path.resolve(filePath)
    const relative = path.relative(base, target)
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
  }

  export function isWritablePath(filePath: string | undefined) {
    if (!filePath) return false
    if (!isReadablePath(filePath)) return false
    const target = path.resolve(filePath)
    if (target === path.resolve(MemoryPath.entrypoint())) return true
    if (!target.toLowerCase().endsWith(".md")) return false

    return MEMORY_TYPES.some((type) => {
      const base = path.resolve(MemoryPath.typeDir(type))
      const relative = path.relative(base, target)
      return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)
    })
  }

  /**
   * Throws when content about to be written to a memory file looks like it contains credentials. The write is
   * rejected rather than silently redacted, so a write never appears to succeed with altered content.
   * Callers (write/edit/multi_edit) should only call this once the target is a memory path (isWritablePath).
   */
  export function assertNoSecrets(content: string) {
    const hits = MemorySecretScan.scan(content)
    if (hits.length === 0) return
    throw new Error(
      `Write rejected: the memory file content appears to contain sensitive credentials (${hits.join(", ")}). Do not store keys, tokens, or private keys in memory; record "where it is configured" instead of the credential itself.`,
    )
  }

  /**
   * Permissions for the memory extraction and consolidation agents: read the workspace and memory directory,
   * write only memory files. Memory directory access skips approval (isProjectFileBypass); every other write,
   * command, and read outside the workspace is denied.
   */
  export function extractorRules() {
    return PermissionNext.fromConfig({ "*": "deny", read: "allow", grep: "allow", glob: "allow", ls: "allow" })
  }
}
