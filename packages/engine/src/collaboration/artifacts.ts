import { Process } from "@merakcode/util/process"
import { inside } from "./paths"

/** Files dirty now that were clean when the group was created. */
export async function changedFiles(cwd: string, baseline: string[]) {
  const now = await porcelain(cwd)
  const before = new Set(baseline)
  return now.filter((file) => !before.has(file.path))
}

export async function porcelain(cwd: string): Promise<{ status: string; path: string }[]> {
  const result = await Process.run(
    ["git", "status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z", "--", "."],
    { cwd, nothrow: true },
  )
  if (result.exitCode !== 0) return []
  const parts = result.text().split("\0").filter(Boolean)
  const files: { status: string; path: string }[] = []
  for (let index = 0; index < parts.length; index++) {
    const entry = parts[index]!
    if (entry.length < 4) continue
    const code = entry.slice(0, 2)
    const path = entry.slice(3)
    if (!path) continue
    const status = code.includes("?") ? "A" : code.includes("D") ? "D" : "M"
    files.push({ status, path: path.replaceAll("\\", "/") })
  }
  return files
}

/** The owner of a file is the member whose todo item has a boundary it falls in: "@name task (src/auth/**)" */
export function withOwners(files: { status: string; path: string }[], todos: { content: string; status: string }[]) {
  const claims = todos
    .filter((item) => item.status !== "cancelled")
    .flatMap((item) => {
      const owner = /@([^\s@]+)/u.exec(item.content)?.[1]
      const boundaries =
        /\(([^()]*)\)\s*$/u
          .exec(item.content)?.[1]
          ?.split(",")
          .map((part) => part.trim()) ?? []
      return owner ? [{ owner, boundaries }] : []
    })
  return files.map((file) => ({
    ...file,
    owner: claims.find((claim) => claim.boundaries.some((boundary) => inside(file.path, boundary)))?.owner,
  }))
}
