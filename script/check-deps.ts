/**
 * Dependency boundaries: product surfaces talk to the engine through the SDK. Only the CLI's engine-host
 * commands (serve, generate, debug) load the engine, and only through its single entry `@merakcode/engine/host`.
 * Clients send requests through the SDK's typed client and read none of the engine's files, apart from the config
 * settings needed before it starts. References are read from the syntax tree, so comments and strings that only
 * mention a module do not count.
 *
 * Usage: pnpm check:deps
 */

import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { parseSync } from "oxc-parser"
import { Filesystem } from "@merakcode/util/filesystem"

/**
 * module: what an import, export ... from, require or resolve names, as written. use: anything else a rule may
 * restrict (see Rule.uses). lazy: not loaded along with the file (dynamic import(), type-only imports, resolve).
 */
type Reference = { line: number; lazy: boolean } & ({ module: string } | { use: string })

/**
 * from/except: files the rule covers; except takes patterns or exact paths.
 * to: modules they may not reference: package names, or repository paths for relative imports.
 * uses: other references they may not make: `<module>#<name>` for an imported name or a property of it,
 *   `computed import()` and `computed require()` for loads whose module is not a literal string,
 *   `fetch()` and `new WebSocket()` (or EventSource, XMLHttpRequest) for raw requests.
 * transitive: files reached from the covered files through relative imports, recursively, are also bound by the rule.
 * eager: only references loaded at startup count; lazy ones are neither followed nor reported.
 */
type Rule = {
  name: string
  from: RegExp
  except?: (RegExp | string)[]
  to?: RegExp
  uses?: RegExp
  transitive?: boolean
  eager?: boolean
}
type Violation = { rule: string; file: string; line: number; target: string }

const ENGINE = /^(packages\/engine|@merakcode\/engine)(\/|$)/
/** The CLI files that load the engine, each through a dynamic import() of its host entry when the command runs */
const HOSTS = /^apps\/cli\/src\/cli\/cmd\/(serve|generate|debug\/host)\.ts$/
const TESTS = /\.test\.[cm]?[jt]sx?$/

const rules: Rule[] = [
  {
    name: "agent-does-not-import-app",
    from: /^packages\/engine\/src\/agent\//,
    except: [TESTS],
    to: /^(packages\/engine\/src\/app\/|@merakcode\/engine\/app\/)/,
  },
  {
    name: "session-records-do-not-import-loop",
    from: /^packages\/engine\/src\/agent\/session\//,
    except: [TESTS],
    to: /^(packages\/engine\/src\/agent\/loop\/|@merakcode\/engine\/agent\/loop\/)/,
  },
  {
    name: "engine-infra-only",
    from: /^packages\/engine\/src\/infra\//,
    except: [TESTS],
    to: /^(packages\/engine\/src\/(?!infra\/)|@merakcode\/engine(?:$|\/(?!infra\/)))/,
  },
  {
    name: "server-does-not-import-host",
    from: /^packages\/engine\/src\/app\/server\//,
    except: [TESTS],
    to: /^(packages\/engine\/src\/app\/host\/|@merakcode\/engine\/app\/host\/)/,
  },
  {
    name: "engine-only-from-cli",
    from: /^(apps|packages)\//,
    except: [/^(apps\/cli|packages\/engine)\//],
    to: ENGINE,
  },
  {
    // Through the CLI's modules the desktop app or a package would load the engine in its own process
    name: "cli-only-from-cli",
    from: /^(apps|packages)\//,
    except: [/^apps\/cli\//],
    to: /^(apps\/cli|merakcode)(\/|$)/,
  },
  {
    // Everything in apps/cli (sources, tests, scripts) may only use the engine's host entry
    name: "apps-engine-host-only",
    from: /^apps\/cli\//,
    except: ["apps/cli/package.json"],
    to: /^(packages\/engine(\/|$)|@merakcode\/engine(?!\/host$)(\/|$))/,
  },
  {
    // run, acp and the management commands are SDK clients; only serve, generate and debug host the engine
    name: "client-through-sdk",
    from: /^apps\/cli\/src\//,
    except: [HOSTS],
    to: ENGINE,
  },
  {
    // A client importing a host file would run the engine in its own process; only the entry registers the commands
    name: "hosts-only-from-entry",
    from: /^apps\/cli\/src\//,
    except: ["apps/cli/src/index.ts", /^apps\/cli\/src\/cli\/cmd\/debug\//],
    to: HOSTS,
  },
  {
    // Every merak process starts here: modules loaded at startup must not pull in the engine
    name: "cli-entry-without-engine",
    from: /^apps\/cli\/src\/index\.ts$/,
    to: ENGINE,
    transitive: true,
    eager: true,
  },
  {
    // A module picked at runtime is beyond the reach of every rule here
    name: "literal-loads-only",
    from: /^(apps|packages)\/(.+\/)?src\//,
    except: [
      /^packages\/engine\//,
      TESTS,
      // undici by a variable name, so web bundles leave it out
      "packages/sdk/js/src/client/client-factory.ts",
    ],
    uses: /^computed /,
  },
  {
    // With the SDK's typed client, a changed route fails the typecheck instead of the user's request
    name: "requests-through-sdk",
    from: /^apps\/(.+\/)?src\//,
    except: [
      TESTS,
      // Third-party servers: releases, the npm registry, connectivity checks, a provider's login endpoint
      "apps/cli/src/cli/installation/index.ts",
      "apps/cli/src/cli/installation/release.ts",
      "apps/cli/src/cli/doctor.ts",
      "apps/cli/src/cli/cmd/provider.ts",
    ],
    to: /^((node:)?(https?|http2)|undici|ws)$/,
    uses: /^(fetch\(\)|new (WebSocket|EventSource|XMLHttpRequest)\(\))$/,
  },
  {
    // Everything a client knows about the engine's config and data comes through the SDK, except what these files need
    name: "engine-files-through-sdk",
    from: /^(apps\/(.+\/)?src|packages\/sdk\/js\/src)\//,
    except: [
      TESTS,
      // The language, needed before the engine starts
      "apps/cli/src/cli/i18n.ts",
      // Config files as they are on disk: doctor reports syntax errors, bug reports attach them
      "apps/cli/src/cli/doctor.ts",
      "apps/cli/src/cli/cmd/bug-report.ts",
    ],
    to: /^@merakcode\/util\/config-peek$/,
    uses: /^@merakcode\/util\/paths#(globalConfigFile|Paths\.(data|worktrees))$/,
  },
  {
    // Provider list adapters stay inside the catalog. Session, UI and billing code see Provider.Model only.
    name: "catalog-adapters-private",
    from: /^packages\/engine\/src\//,
    except: ["packages/engine/src/agent/model/catalog.ts", /^packages\/engine\/src\/agent\/model\/catalog\//, TESTS],
    to: /^packages\/engine\/src\/agent\/model\/catalog\/(deepseek|alibaba|openrouter|anthropic|openai|google|zhipu|moonshot|relay|config)\.ts$/,
  },
]

type Node = { type: string; start: number; [key: string]: unknown }

/** The string a node spells out: a string literal, or a template literal without substitutions */
function literal(value: unknown) {
  const node = value as Node | null | undefined
  if (node?.type === "Literal" && typeof node.value === "string") return node.value
  if (node?.type !== "TemplateLiteral" || (node.expressions as unknown[]).length > 0) return
  return ((node.quasis as Node[])[0]!.value as { cooked: string }).cooked
}

/** Name of an identifier, or of the property in `a.b` and `a["b"]` */
function named(node: Node): string | undefined {
  if (node.type === "Identifier") return node.name as string
  if (node.type !== "MemberExpression") return literal(node)
  const key = node.property as Node
  return !node.computed && key.type === "Identifier" ? (key.name as string) : literal(key)
}

/** `require(...)`, or the function `createRequire(...)` returns, called right away */
function loads(callee: Node) {
  if (callee.type === "Identifier") return callee.name === "require"
  return callee.type === "CallExpression" && named(callee.callee as Node) === "createRequire"
}

/** `require.resolve`, `import.meta.resolve` and `createRequire(...).resolve` */
function resolves(callee: Node) {
  if (callee.type !== "MemberExpression" || named(callee) !== "resolve") return false
  const object = callee.object as Node
  return object.type === "MetaProperty" || loads(object)
}

const REQUESTS = new Set(["WebSocket", "EventSource", "XMLHttpRequest"])

function references(file: string, text: string): Reference[] {
  const { program } = parseSync(file, text)
  const starts = [0, ...[...text.matchAll(/\n/g)].map((match) => match.index + 1)]
  const line = (node: Node) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (starts[mid]! <= node.start) low = mid
      else high = mid - 1
    }
    return low + 1
  }

  // Imported names by local name: `<module>#<name>`, or `<module>#` for a namespace
  const bindings = new Map<string, string>()
  for (const statement of program.body as unknown as Node[]) {
    if (statement.type !== "ImportDeclaration") continue
    const from = literal(statement.source)!
    for (const specifier of statement.specifiers as Node[]) {
      const local = named(specifier.local as Node)!
      if (specifier.type === "ImportNamespaceSpecifier") bindings.set(local, `${from}#`)
      else if (specifier.type === "ImportDefaultSpecifier") bindings.set(local, `${from}#default`)
      else bindings.set(local, `${from}#${named(specifier.imported as Node)}`)
    }
  }
  const member = (base: string, name: string) => (base.endsWith("#") ? base + name : `${base}.${name}`)
  /** What an expression stands for in terms of imports: `<module>#Paths.data` for `Paths.data` */
  const qualified = (node: Node): string | undefined => {
    if (node.type === "Identifier") return bindings.get(node.name as string)
    if (node.type !== "MemberExpression") return
    const base = qualified(node.object as Node)
    const name = named(node)
    return base && name !== undefined ? member(base, name) : undefined
  }

  const found: Reference[] = []
  const module = (node: Node, source: unknown, lazy: boolean) => {
    const name = literal(source)
    if (name !== undefined) found.push({ module: name, line: line(node), lazy })
  }
  const use = (node: Node, name: string, lazy = false) => found.push({ use: name, line: line(node), lazy })

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit)
    if (!value || typeof value !== "object") return
    const node = value as Node
    switch (node.type) {
      case "ImportDeclaration":
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration": {
        const from = literal(node.source)
        if (from === undefined) break
        const lazy = node.importKind === "type" || node.exportKind === "type"
        module(node, node.source, lazy)
        for (const specifier of (node.specifiers as Node[] | undefined) ?? []) {
          if (specifier.type === "ImportSpecifier") use(specifier, `${from}#${named(specifier.imported as Node)}`, lazy)
          if (specifier.type === "ExportSpecifier") use(specifier, `${from}#${named(specifier.local as Node)}`, lazy)
        }
        break
      }
      case "TSImportEqualsDeclaration": {
        const reference = node.moduleReference as Node
        if (reference.type === "TSExternalModuleReference")
          module(node, reference.expression, node.importKind === "type")
        break
      }
      case "TSImportType":
        module(node, node.source, true)
        break
      case "ImportExpression":
        if (literal(node.source) === undefined) use(node, "computed import()", true)
        else module(node, node.source, true)
        break
      case "CallExpression": {
        const callee = node.callee as Node
        const first = (node.arguments as Node[])[0]
        if (loads(callee)) {
          if (literal(first) === undefined) use(node, "computed require()")
          else module(node, first, false)
        } else if (resolves(callee)) module(node, first, true)
        else if (named(callee) === "fetch") use(node, "fetch()")
        break
      }
      case "NewExpression": {
        const name = named(node.callee as Node)
        if (name && REQUESTS.has(name)) use(node, `new ${name}()`)
        break
      }
      case "MemberExpression": {
        const name = qualified(node)
        if (name) use(node, name)
        break
      }
      case "VariableDeclarator": {
        const pattern = node.id as Node
        const base = node.init ? qualified(node.init as Node) : undefined
        if (pattern.type !== "ObjectPattern" || !base) break
        for (const property of pattern.properties as Node[]) {
          const name = property.type === "Property" && !property.computed ? named(property.key as Node) : undefined
          if (name !== undefined) use(property, member(base, name))
        }
        break
      }
    }
    for (const [key, child] of Object.entries(node)) if (key !== "parent" && typeof child === "object") visit(child)
  }
  visit(program)
  return found.sort((a, b) => a.line - b.line)
}

const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]

/** The package a dependency installs: an `npm:` or `workspace:` alias installs the one it names, a path that folder */
function installs(name: string, spec: string) {
  const alias = /^(?:npm:((?:@[\w.~-]+\/)?[\w.~-]+)(?:@|$)|workspace:((?:@[\w.~-]+\/)?[\w.~-]+)@)/.exec(spec)
  if (alias) return alias[1] ?? alias[2]!
  const folder = /^(?:(?:file|link|portal|workspace):)?(\.{1,2}\/.*)$/.exec(spec)
  return folder ? folder[1]! : name
}

/** Every string in a JSON value, nested conditions included */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (!value || typeof value !== "object") return []
  return Object.values(value).flatMap(strings)
}

/** What a package.json pulls in: its dependencies, and the targets of its `imports` map */
function manifest(text: string): Reference[] {
  const lines = text.split("\n")
  const at = (needle: string) => lines.findIndex((item) => item.includes(needle)) + 1
  const pkg = JSON.parse(text) as Record<string, unknown>
  const dependencies = sections.flatMap((section) => Object.entries((pkg[section] ?? {}) as Record<string, string>))
  return [
    ...dependencies.map(([name, spec]) => ({ module: installs(name, spec), line: at(`"${name}"`), lazy: false })),
    ...strings(pkg.imports).map((target) => ({ module: target, line: at(`"${target}"`), lazy: false })),
  ].sort((a, b) => a.line - b.line)
}

function targets(file: { path: string; text: string }) {
  return path.posix.basename(file.path) === "package.json" ? manifest(file.text) : references(file.path, file.text)
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

function covers(rule: Rule, file: string) {
  if (!rule.from.test(file)) return false
  return !rule.except?.some((item) => (typeof item === "string" ? item === file : item.test(file)))
}

/** Files covered by the rule */
function scope(rule: Rule, imports: Map<string, Reference[]>) {
  const start = [...imports.keys()].filter((file) => covers(rule, file))
  const seen = new Set(start)
  if (!rule.transitive) return seen
  const queue = [...start]
  while (queue.length > 0) {
    const file = queue.pop()!
    for (const reference of imports.get(file)!) {
      if (!("module" in reference) || (rule.eager && reference.lazy)) continue
      const next = reference.module.startsWith(".") ? source(imports, resolve(file, reference.module)) : undefined
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
  const breaks = (rule: Rule, file: string, reference: Reference) => {
    if (!("module" in reference)) return !!rule.uses?.test(reference.use)
    if (!rule.to) return false
    const target = resolve(file, reference.module)
    return rule.to.test(reference.module.startsWith(".") ? (source(imports, target) ?? target) : target)
  }
  return files.flatMap((file) =>
    imports.get(file.path)!.flatMap((reference) =>
      scopes
        .filter(
          (item) =>
            item.files.has(file.path) &&
            !(item.rule.eager && reference.lazy) &&
            breaks(item.rule, file.path, reference),
        )
        .map((item) => ({
          rule: item.rule.name,
          file: file.path,
          line: reference.line,
          target: "module" in reference ? reference.module : reference.use,
        })),
    ),
  )
}

async function main() {
  const root = path.resolve(import.meta.dirname, "..")
  // Tracked and new files: build output and dependencies are ignored by git, generated sources are checked too
  const paths = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "apps", "packages"],
    {
      cwd: root,
      encoding: "utf8",
    },
  )
    .split("\0")
    .filter((file) => /(^|\/)package\.json$|\.[cm]?[jt]sx?$/.test(file) && existsSync(path.join(root, file)))
  const files = await Promise.all(
    paths.map(async (file) => ({ path: file, text: await Filesystem.readText(path.join(root, file)) })),
  )
  const found = violations(files)
  for (const item of found) console.error(`${item.file}:${item.line} ${item.target} (${item.rule})`)
  console.log(`${files.length} files checked, ${found.length} dependency boundary violations`)
  if (found.length > 0) process.exitCode = 1
}

if (import.meta.main) await main()
