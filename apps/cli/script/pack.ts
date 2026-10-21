/**
 * Prepares the npm release: next to the platform directories from build.ts, generates the main merakcode package and
 * the SDK, and writes the publish script.
 *
 *   dist/npm/merakcode/                    main package: command entry bin/merak; npm installs only the host's
 *                                          platform package by os/cpu
 *   dist/npm/sdk/                          @merakcode/sdk: same version as the main package, its engine uses the
 *                                          same platform packages
 *   dist/merakcode-<version>-<platform>/   platform package (from build.ts; the directory itself is an npm package)
 *   dist/npm/*.tgz                         every package above, packed by npm pack
 *   dist/npm/publish.sh                    publishes the .tgz files: the platform packages, then the SDK and the main
 *                                          package; skips versions already published
 *
 * Publishing the packed files (not the directories) keeps file modes: CI moves them between jobs as artifacts, which
 * would drop the executable bit of node/bin/node, and the release smoke test installs the same files.
 * Nothing is published here; the release workflow runs publish.sh. To try the packages locally, install the main
 * package's .tgz together with this machine's platform package .tgz.
 * Usage (in apps/cli): pnpm pack:npm
 */
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { binMap } from "../bin/cli-name.cjs"
import { build as buildSdk } from "../../../packages/sdk/js/script/build"

type Manifest = { name: string; version: string; license?: string; repository?: unknown }

/** A package packed by npm pack: file is the .tgz name next to publish.sh */
export type Packed = { name: string; version: string; file: string }

/**
 * Main package: only the command entry. Every platform package is an optional dependency, and npm installs only the
 * one matching the host's os/cpu
 */
export function mainPackage(cli: Manifest, platforms: Record<string, string>) {
  return {
    name: cli.name,
    version: cli.version,
    description: "MerakCode command line: run tasks, start the engine, ACP for editors",
    license: cli.license,
    repository: cli.repository,
    bin: binMap(),
    files: ["bin", "THIRD_PARTY_NOTICES.md"],
    engines: { node: ">=18" },
    optionalDependencies: platforms,
  }
}

/** Platform directories built by build.ts under dist: name → path. Every one must be at `version` */
export function platformPackages(dist: string, version: string) {
  const found: Record<string, string> = {}
  for (const entry of readdirSync(dist, { withFileTypes: true })) {
    const manifest = path.join(dist, entry.name, "package.json")
    if (!entry.isDirectory() || !entry.name.startsWith("merakcode-") || !existsSync(manifest)) continue
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as Manifest
    if (parsed.version !== version)
      throw new Error(
        `${entry.name} is at ${parsed.version}, which does not match the CLI version ${version}; rebuild first`,
      )
    found[parsed.name] = path.join(dist, entry.name)
  }
  return found
}

/** The SDK ships at the CLI's version: the engine the SDK starts is this version's platform package */
export function sameVersion(cli: Manifest, sdk: Manifest) {
  if (sdk.version !== cli.version)
    throw new Error(
      `${sdk.name} is at ${sdk.version} but ${cli.name} is at ${cli.version}; set them to the same version`,
    )
}

/** npm dist-tag for a version: latest for releases, the channel name (beta, rc …) for pre-releases */
export function npmTag(version: string) {
  const pre = version.split("-")[1]
  return pre ? (pre.split(".")[0] ?? "next") : "latest"
}

/**
 * `packages` depend on `platforms`, so platforms are published first: by the time users install the SDK or the main
 * package, the platform packages they depend on exist
 */
export function publishScript(platforms: Packed[], packages: Packed[], tag = "latest") {
  const run = (item: Packed) =>
    `publish ${[item.name, item.version, item.file].map((v) => JSON.stringify(v)).join(" ")}`
  return [
    "#!/bin/sh",
    "# Platform packages go first, then the SDK and main package that depend on them: once the main package is out,",
    "# users start installing the platform packages it depends on",
    "set -e",
    'cd "$(dirname "$0")"',
    "",
    "publish() {",
    '  if npm view "$1@$2" version >/dev/null 2>&1; then',
    '    echo "==> $1@$2 is already published, skipping"',
    "    return",
    "  fi",
    '  echo "==> publishing $1@$2"',
    `  npm publish --access public --tag ${tag} "./$3"`,
    "}",
    "",
    ...platforms.map(run),
    ...packages.map(run),
    "",
  ].join("\n")
}

/** npm bundled with the running node (next to node.exe on Windows, under ../lib on Unix); avoids npm.cmd via a shell */
function npmCli() {
  const dir = path.dirname(process.execPath)
  const found = [
    path.join(dir, "node_modules/npm/bin/npm-cli.js"),
    path.join(dir, "../lib/node_modules/npm/bin/npm-cli.js"),
  ].find(existsSync)
  if (!found) throw new Error("npm bundled with node not found")
  return found
}

if (import.meta.main) {
  const cli = path.resolve(import.meta.dirname, "..")
  const dist = path.join(cli, "dist")
  const manifest = JSON.parse(await fs.readFile(path.join(cli, "package.json"), "utf8")) as Manifest
  sameVersion(
    manifest,
    JSON.parse(await fs.readFile(path.join(cli, "../../packages/sdk/js/package.json"), "utf8")) as Manifest,
  )
  const platforms = platformPackages(dist, manifest.version)
  if (Object.keys(platforms).length === 0) throw new Error("No platform packages in dist; run pnpm build first")

  const npm = path.join(dist, "npm")
  const main = path.join(npm, manifest.name)
  await fs.rm(npm, { recursive: true, force: true })
  for (const name of ["merak", "cli-name.cjs"]) await fs.cp(path.join(cli, "bin", name), path.join(main, "bin", name))
  await fs.copyFile(
    path.join(cli, "../../packages/log/src/crash-evidence.cjs"),
    path.join(main, "bin", "crash-evidence.cjs"),
  )
  await fs.copyFile(path.join(cli, "../../LICENSE"), path.join(main, "LICENSE"))
  await fs.copyFile(path.join(cli, "../../README.en.md"), path.join(main, "README.md"))
  await fs.copyFile(path.join(cli, "../../THIRD_PARTY_NOTICES.md"), path.join(main, "THIRD_PARTY_NOTICES.md"))
  const versions = Object.fromEntries(Object.keys(platforms).map((name) => [name, manifest.version]))
  await fs.writeFile(path.join(main, "package.json"), JSON.stringify(mainPackage(manifest, versions), null, 2) + "\n")
  const sdk = path.join(npm, "sdk")
  await buildSdk({ outdir: sdk, version: manifest.version, platforms: Object.keys(platforms) })

  const pack = (dir: string): Packed => {
    const output = execFileSync(
      process.execPath,
      [npmCli(), "pack", dir, "--pack-destination", npm, "--ignore-scripts", "--json"],
      { encoding: "utf8" },
    )
    const [result] = JSON.parse(output) as { name: string; version: string; filename: string }[]
    return { name: result!.name, version: result!.version, file: path.basename(result!.filename) }
  }
  await fs.writeFile(
    path.join(npm, "publish.sh"),
    publishScript(Object.values(platforms).map(pack), [sdk, main].map(pack), npmTag(manifest.version)),
    { mode: 0o755 },
  )
  // npm pack takes file modes from the file system, and Windows has no executable bit
  if (process.platform === "win32" && Object.keys(platforms).some((name) => !name.startsWith("merakcode-windows-")))
    console.warn("Packed on Windows: the Linux and macOS packages cannot run; publish them from CI only")
  console.log(`Packed the main package, the SDK and ${Object.keys(platforms).length} platform packages: ${npm}`)
}
