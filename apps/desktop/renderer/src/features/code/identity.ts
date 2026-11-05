import { gitDirectory, resolveDirectory } from "../../state/git"
import { decodeDir, relative, sameDir } from "../../lib/route"
import { persistent } from "../../lib/persistence"

function normalize(path: string) {
  const value = path.replace(/\\/g, "/").normalize("NFC")
  const prefix = value.startsWith("//") ? "//" : value.startsWith("/") ? "/" : ""
  const parts: string[] = []
  for (const part of value.split("/")) {
    if (!part || part === ".") continue
    if (part === ".." && parts.length && parts.at(-1) !== ".." && !parts.at(-1)!.endsWith(":")) parts.pop()
    else if (part !== ".." || !prefix) parts.push(part)
  }
  return prefix + parts.join("/")
}

/** One lexical file address within the checkout confirmed by the engine. */
export async function fileDirectories(prefix: string, directory: string) {
  const actual = gitDirectory(directory)
  const candidates = (await persistent.buckets())
    .filter((bucket) => bucket.startsWith(prefix))
    .flatMap((bucket) => {
      const value = decodeDir(bucket.slice(prefix.length))
      return value ? [value] : []
    })
  const related: string[] = []
  for (const candidate of candidates) {
    const source = normalize(candidate)
    const target = normalize(actual)
    if (sameDir(normalize(gitDirectory(candidate)), target)) {
      related.push(candidate)
      continue
    }
    if (!sameDir(source.slice(0, target.length), target) || source[target.length] !== "/") continue
    const resolved = await resolveDirectory(candidate)
    if (sameDir(normalize(resolved), target)) related.push(candidate)
  }
  return [...new Set([directory, actual, ...related])]
}

export function fileAddress(directory: string, path: string, planSessionID?: string) {
  const actual = gitDirectory(directory)
  if (planSessionID)
    return { directory: actual, path: `merakcode-plan://${encodeURIComponent(planSessionID)}/Plan-${planSessionID}.md` }
  if (path.startsWith("merakcode-plan://")) return { directory: actual, path }
  const root = normalize(actual)
  if (!root) return { directory: actual, path: normalize(path) }
  const absolute = /^(?:[a-z]:[\\/]|[\\/])/i.test(path) ? normalize(path) : normalize(`${normalize(directory)}/${path}`)
  const canonical = relative(root, absolute)
  return { directory: actual, path: /^[a-z]:/i.test(root) ? canonical.toLowerCase() : canonical }
}
