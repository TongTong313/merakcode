/**
 * Builds THIRD_PARTY_LICENSES.txt for release packages. Packages come from two sources, merged into one list:
 * - `pnpm licenses list --prod --json` in workspace directories. pnpm does not follow workspace packages, so each
 *   workspace package that ends up in the bundle is listed.
 * - the files a bundler put into its output (from esbuild's metafile), mapped to the npm packages that own them. This
 *   covers bundles whose dependencies are not production dependencies (the desktop main process lists every
 *   dependency under devDependencies).
 */
import { execSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

export type Entry = { name: string; versions: string[]; license: string; paths: string[] }

export function merge(lists: Entry[][]): Entry[] {
  const byName = new Map<string, Entry>()
  for (const entry of lists.flat()) {
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

type Manifest = { name: string; version: string; license?: unknown; licenses?: unknown }

/** License id from package.json: the SPDX `license` string, or the deprecated `{ type }` object and `licenses` array */
function licenseOf(manifest: Manifest) {
  const items = [manifest.license, ...(Array.isArray(manifest.licenses) ? manifest.licenses : [manifest.licenses])]
  const ids = items.flatMap((item) => {
    if (typeof item === "string") return [item]
    const type = (item as { type?: unknown } | undefined)?.type
    return typeof type === "string" ? [type] : []
  })
  return ids.join(" OR ") || "Unknown"
}

/** Directory of the npm package that owns a file: the name after the last node_modules segment */
function packageDir(file: string) {
  const parts = path.resolve(file).split(/[\\/]/)
  const at = parts.lastIndexOf("node_modules")
  if (at < 0) return
  const name = parts[at + 1]?.startsWith("@") ? 2 : 1
  return parts.slice(0, at + 1 + name).join(path.sep)
}

/** npm packages that own the given bundled files, read from their package.json; files outside node_modules are skipped */
export function owners(files: string[]): Entry[] {
  const dirs = new Set(files.flatMap((file) => packageDir(file) ?? []))
  return [...dirs].map((dir) => {
    const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as Manifest
    return { name: manifest.name, versions: [manifest.version], license: licenseOf(manifest), paths: [dir] }
  })
}

const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt))?$/i

/** First license file in a package directory */
function readLicense(dir: string) {
  if (!existsSync(dir)) return
  const file = readdirSync(dir).find((name) => LICENSE_FILE.test(name))
  return file ? readFileSync(path.join(dir, file), "utf8") : undefined
}

/**
 * Renders the merged list: the production dependencies of each workspace directory in `dirs` (from pnpm) and the
 * packages owning the bundled `files`
 */
export function collect(dirs: string[], files: string[] = []) {
  const reports = dirs.map((cwd) =>
    Object.values(
      JSON.parse(
        execSync("pnpm licenses list --prod --json", { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }),
      ) as Record<string, Entry[]>,
    ).flat(),
  )
  return render(merge([...reports, owners(files)]), readLicense)
}
