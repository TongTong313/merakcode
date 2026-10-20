/**
 * Keeps .git/hooks and .git/config as they were before a sandboxed command ran. A changed hook or config would run
 * code outside the sandbox the next time the user runs git, so changes are rolled back and reported.
 */
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

export namespace Guard {
  /** Regular files under the protected paths and their content */
  export type Snapshot = Map<string, Buffer>

  /** Every entry under `target` (itself if it is a file); directories are listed after their contents */
  function entries(target: string): { file: string; regular: boolean }[] {
    const stat = (() => {
      try {
        return lstatSync(target)
      } catch {
        return undefined
      }
    })()
    if (!stat) return []
    if (!stat.isDirectory()) return [{ file: target, regular: stat.isFile() }]
    return readdirSync(target).flatMap((name) => entries(path.join(target, name)))
  }

  export function snapshot(protect: string[]): Snapshot {
    return new Map(
      protect
        .flatMap(entries)
        .filter((entry) => entry.regular)
        .map((entry) => [entry.file, readFileSync(entry.file)] as const),
    )
  }

  /** Puts changed and deleted files back and removes new ones; returns what it touched */
  export function restore(protect: string[], before: Snapshot): string[] {
    const now = protect.flatMap(entries)
    const added = now.filter((entry) => !before.has(entry.file)).map((entry) => entry.file)
    const changed = [...before].filter(([file, content]) => {
      const current = now.find((entry) => entry.file === file)
      return !current || !current.regular || !readFileSync(file).equals(content)
    })
    for (const file of added) rmSync(file, { force: true, recursive: true })
    for (const [file, content] of changed) {
      rmSync(file, { force: true, recursive: true })
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, content)
    }
    return [...added, ...changed.map(([file]) => file)].sort()
  }
}
