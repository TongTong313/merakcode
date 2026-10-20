/**
 * Dependency boundaries: product surfaces talk to the engine through the SDK. Only the CLI's engine-host
 * commands (serve, generate, debug) load the engine, and only through its single entry `@merakcode/engine/host`.
 *
 * Usage: pnpm check:deps
 */

import path from "node:path"
import { Filesystem } from "@merakcode/util/filesystem"
import { Glob } from "@merakcode/util/glob"

/**
 * transitive: files reached from the `from` files through relative imports, recursively, are also bound by the rule.
 * eager: only imports loaded at startup count; dynamic import() is neither followed nor reported.
 */
type Rule = { name: string; from: RegExp; to: RegExp; transitive?: boolean; eager?: boolean }
type Violation = { rule: string; file: string; line: number; target: string }

const ENGINE = /^(packages\/engine\/|@merakcode\/engine(\/|$))/

const rules: Rule[] = [
  {
    name: "engine-only-from-cli",
    from: /^(apps\/desktop\/|packages\/(?!engine\/))/,
    to: ENGINE,
  },
  {
    // Everything in apps/cli (sources, tests, scripts) may only use the engine's host entry
    name: "apps-engine-host-only",
    from: /^apps\/cli\/(?!package\.json$)/,
    to: /^(packages\/engine\/|@merakcode\/engine(?!\/host$)(\/|$))/,
  },
  {
    // The TUI, run, acp and management commands are SDK clients; only serve, generate and debug host the engine
    name: "client-through-sdk",
    from: /^apps\/cli\/src\/(?!cli\/cmd\/(serve|generate)\.ts$|cli\/cmd\/debug\/\w+\.ts$)/,
    to: ENGINE,
  },
  {
    // Every merak process starts here: modules loaded at startup must not pull in the engine
    name: "cli-entry-without-engine",
    from: /^apps\/cli\/src\/index\.ts$/,
    to: ENGINE,
    transitive: true,
    eager: true,
  },
]

const specifier = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\brequire\s*\(\s*)["']([^"']+)["']/g
const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]

/** Modules a file depends on: import specifiers for sources, declared dependency names for package.json */
function targets(file: { path: string; text: string }) {
  const lines = file.text.split("\n")
  if (path.posix.basename(file.path) === "package.json") {
    const pkg = JSON.parse(file.text) as Record<string, Record<string, string> | undefined>
    return sections
      .flatMap((section) => Object.keys(pkg[section] ?? {}))
      .map((target) => ({ target, line: lines.findIndex((text) => text.includes(`"${target}"`)) + 1, lazy: false }))
  }
  return lines.flatMap((text, index) =>
    [...text.matchAll(specifier)].map((match) => ({
      target: match[2]!,
      line: index + 1,
      lazy: /^import\s*\(/.test(match[1]!),
    })),
  )
}

/** Turns a relative import into a repository-relative path; package names are returned as is */
function resolve(file: string, target: string) {
  return target.startsWith(".") ? path.posix.join(path.posix.dirname(file), target) : target
}

/**
 * Source file a relative import points to; imports without an extension or written as .js resolve to the source.
 * Importing package.json (for the version) only reads data and loads none of its dependencies, so it is not followed.
 */
function source(known: Map<string, unknown>, file: string) {
  const base = file.replace(/\.[mc]?js$/, "")
  const candidates = ["", "/index"].flatMap((suffix) =>
    [".ts", ".tsx", ".mts", ".cts"].map((ext) => base + suffix + ext),
  )
  return [file, ...candidates].find((item) => known.has(item) && path.posix.basename(item) !== "package.json")
}

/** Files covered by the rule */
function scope(rule: Rule, imports: Map<string, ReturnType<typeof targets>>) {
  const start = [...imports.keys()].filter((file) => rule.from.test(file))
  const seen = new Set(start)
  if (!rule.transitive) return seen
  const queue = [...start]
  while (queue.length > 0) {
    const file = queue.pop()!
    for (const { target, lazy } of imports.get(file)!) {
      if (rule.eager && lazy) continue
      const next = target.startsWith(".") ? source(imports, resolve(file, target)) : undefined
      if (next && !seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
  return seen
}

export function violations(files: { path: string; text: string }[]): Violation[] {
  const imports = new Map(files.map((file) => [file.path, targets(file)]))
  const scopes = rules.map((rule) => ({ rule, files: scope(rule, imports) }))
  return files.flatMap((file) =>
    imports
      .get(file.path)!
      .flatMap(({ target, line, lazy }) =>
        scopes
          .filter(
            (item) =>
              item.files.has(file.path) && !(item.rule.eager && lazy) && item.rule.to.test(resolve(file.path, target)),
          )
          .map((item) => ({ rule: item.rule.name, file: file.path, line, target })),
      ),
  )
}

async function main() {
  const root = path.resolve(import.meta.dirname, "..")
  const paths = new Glob("{apps,packages}/**/{package.json,*.{ts,tsx,mts,cts,js,mjs,cjs}}")
    .scanSync({ cwd: root })
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !/(^|\/)(node_modules|dist|gen)\//.test(file))
  const files = await Promise.all(
    paths.map(async (file) => ({ path: file, text: await Filesystem.readText(path.join(root, file)) })),
  )
  const found = violations(files)
  for (const item of found) console.error(`${item.file}:${item.line} ${item.target} (${item.rule})`)
  console.log(`${files.length} files checked, ${found.length} dependency boundary violations`)
  if (found.length > 0) process.exitCode = 1
}

if (import.meta.main) await main()
