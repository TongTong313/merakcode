/**
 * Builds THIRD_PARTY_LICENSES.txt for release packages from `pnpm licenses list --prod --json`.
 * pnpm does not follow workspace packages, so each workspace package that ends up in the bundle is listed.
 */
import { execSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

export type Entry = { name: string; versions: string[]; license: string; paths: string[] }

export function merge(reports: Record<string, Entry[]>[]): Entry[] {
  const byName = new Map<string, Entry>()
  for (const entry of reports.flatMap((report) => Object.values(report).flat())) {
    if (entry.name.startsWith("@merakcode/")) continue
    const known = byName.get(entry.name)
    byName.set(entry.name, {
      ...entry,
      versions: [...new Set([...(known?.versions ?? []), ...entry.versions])].sort(),
      paths: [...new Set([...(known?.paths ?? []), ...entry.paths])],
    })
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function render(entries: Entry[], read: (dir: string) => string | undefined): string {
  const blocks = entries.map((entry) => {
    const text =
      entry.paths.map(read).find(Boolean) ??
      `License text not included in the package; see the ${entry.license} license.`
    return [`${entry.name}@${entry.versions.join(", ")} (${entry.license})`, "", text.trim()].join("\n")
  })
  return [
    "Third-party software bundled with MerakCode",
    "",
    ...blocks.flatMap((block) => ["=".repeat(80), block, ""]),
  ].join("\n")
}

const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt))?$/i

/** First license file in a package directory */
function readLicense(dir: string) {
  if (!existsSync(dir)) return
  const file = readdirSync(dir).find((name) => LICENSE_FILE.test(name))
  return file ? readFileSync(path.join(dir, file), "utf8") : undefined
}

/** Runs pnpm in each workspace directory and renders the merged list */
export function collect(dirs: string[]) {
  const reports = dirs.map(
    (cwd) =>
      JSON.parse(
        execSync("pnpm licenses list --prod --json", { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }),
      ) as Record<string, Entry[]>,
  )
  return render(merge(reports), readLicense)
}
