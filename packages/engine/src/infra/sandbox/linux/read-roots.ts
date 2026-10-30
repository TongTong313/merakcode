/**
 * Landlock can only add access, never take it away inside a granted folder. To read everything except a few
 * folders, grant the siblings along the way instead: each folder on the path to a denied one is replaced by its
 * children, except the child that leads to the denied folder.
 */
import { existsSync, lstatSync, readdirSync } from "node:fs"
import path from "node:path"

const inside = (parent: string, child: string) => {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export function readRoots(deny: string[], root = "/"): string[] {
  const denied = deny.map((dir) => path.resolve(dir)).filter((dir) => existsSync(dir) && inside(root, dir))
  const expand = (dir: string): string[] => {
    const below = denied.filter((item) => inside(dir, item))
    if (!below.length) return [dir]
    if (below.some((item) => item === dir)) return []
    const children = (() => {
      try {
        return readdirSync(dir)
      } catch {
        return undefined
      }
    })()
    // A folder on the way that cannot be listed cannot be split safely, so it is left out
    if (!children) return []
    return children.flatMap((name) => {
      const child = path.join(dir, name)
      // Symlinks are not granted themselves: what they point to is decided where the target lives
      if (lstatSync(child, { throwIfNoEntry: false })?.isSymbolicLink()) return []
      return expand(child)
    })
  }
  return expand(path.resolve(root))
}
