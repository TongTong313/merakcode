import { dirname, isAbsolute, join, relative, resolve } from "path"

/**
 * Resolves the install root to uninstall from a SKILL.md path: the first-level directory under an allowed root.
 *
 * - Uninstall removes the whole tree: zip extraction or repository copies can nest outer/inner directories, and
 *   deleting dirname(SKILL.md) would leave the outer directory behind.
 * - Safety boundary: returns undefined when location is outside every allowed root or is a root itself, so the caller
 *   refuses.
 */
export function resolveSkillInstallRoot(location: string, allowedDirs: string[]): string | undefined {
  const skillDir = resolve(dirname(location))
  for (const dir of allowedDirs) {
    const root = resolve(dir)
    const rel = relative(root, skillDir)
    // Empty rel is the root itself; a rel starting with .. or absolute is outside it. Both are refused
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue
    return join(root, rel.split(/[\\/]/)[0])
  }
  return undefined
}
