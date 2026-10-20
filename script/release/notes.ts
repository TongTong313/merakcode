/**
 * Release notes for a version, cut from CHANGELOG.md (## [x.y.z] or ## x.y.z up to the next ## heading).
 *   node --import ./script/node/register.mjs script/release/notes.ts 0.2.0 > notes.md
 */
import { readFileSync } from "node:fs"
import path from "node:path"

export function notes(changelog: string, version: string) {
  const lines = changelog.split(/\r?\n/)
  const escaped = version.replaceAll(".", "\\.")
  const start = lines.findIndex((line) => new RegExp(`^##\\s+\\[?${escaped}\\]?(\\s|$)`).test(line))
  if (start < 0) return `MerakCode ${version}. See CHANGELOG.md for what changed.`
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line))
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim()
}

if (import.meta.main) {
  const version = process.argv[2]
  if (!version) throw new Error("usage: notes.ts <version>")
  const file = path.resolve(import.meta.dirname, "..", "..", "CHANGELOG.md")
  const text = (() => {
    try {
      return readFileSync(file, "utf8")
    } catch {
      return ""
    }
  })()
  process.stdout.write(notes(text, version) + "\n")
}
