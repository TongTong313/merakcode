/**
 * Release notes for a version, cut from CHANGELOG.md (## [x.y.z] or ## x.y.z up to the next ## heading).
 *   node --import ./script/node/register.mjs script/release/notes.ts 0.2.0 > notes.md
 *   --require  fail when CHANGELOG.md has no section for the version (checked before publishing a release)
 */
import { readFileSync } from "node:fs"
import path from "node:path"

/** The version's section without its heading; undefined when there is none or it is empty */
export function section(changelog: string, version: string) {
  const lines = changelog.split(/\r?\n/)
  const escaped = version.replaceAll(".", "\\.")
  const start = lines.findIndex((line) => new RegExp(`^##\\s+\\[?${escaped}\\]?(\\s|$)`).test(line))
  if (start < 0) return undefined
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line))
  const text = lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim()
  return text || undefined
}

export function notes(changelog: string, version: string) {
  return section(changelog, version) ?? `MerakCode ${version}. See CHANGELOG.md for what changed.`
}

if (import.meta.main) {
  const version = process.argv[2]
  if (!version) throw new Error("usage: notes.ts <version> [--require]")
  const file = path.resolve(import.meta.dirname, "..", "..", "CHANGELOG.md")
  const text = (() => {
    try {
      return readFileSync(file, "utf8")
    } catch {
      return ""
    }
  })()
  if (process.argv.includes("--require") && !section(text, version)) {
    console.error(`CHANGELOG.md has no notes for ${version}: rename Unreleased to "## [${version}] - date"`)
    process.exit(1)
  }
  process.stdout.write(notes(text, version) + "\n")
}
