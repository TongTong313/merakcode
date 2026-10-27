/**
 * Builds the files of the adapter-generator skill that come from code: the adapter library as one file
 * (merakcode-adapter.mjs, from @merakcode/sdk/adapter) with its type declarations (merakcode-adapter.d.mts), and the
 * examples, which are MerakCode's own TypeScript adapters for Claude Code, Codex and OpenCode, importing the library
 * beside them. Node runs them as they are; they need nothing else.
 *
 * Usage (repo root): pnpm generate:adapter-library, or pnpm check:adapter-library to fail when they are out of date.
 */
import path from "node:path"
import { build } from "esbuild"
import { format, resolveConfig } from "prettier"
import ts from "typescript"
import { Filesystem } from "@merakcode/util/filesystem"

const root = path.resolve(import.meta.dirname, "..", "..", "..", "..")
const source = path.join(root, "packages", "sdk", "js", "src", "adapter", "index.ts")
const adapters = path.join(root, "packages", "engine", "src", "agent-connection", "adapters")
const folder = path.join(root, "packages", "engine", "src", "skill", "builtin", "adapter-generator")
/** Each example, and the built-in adapter it is */
const EXAMPLES = {
  "example-claude-code.mts": "claude",
  "example-codex.mts": "codex",
  "example-opencode.mts": "opencode",
}

/** The library as one ES module */
export async function bundle() {
  const result = await build({
    entryPoints: [source],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    write: false,
    legalComments: "none",
    logLevel: "silent",
    // cross-spawn is CommonJS: its require calls of Node built-ins need a require in an ES module
    banner: {
      js: 'import { createRequire as __merakcodeRequire } from "node:module"\nconst require = __merakcodeRequire(import.meta.url)',
    },
    // Run as a program (node merakcode-adapter.mjs check|test ...) it tries an adapter; imported, it does nothing
    footer: {
      js: [
        'import { fileURLToPath as __merakcodeFile } from "node:url"',
        'if (process.argv[1] && __merakcodeFile(import.meta.url) === (await import("node:fs")).realpathSync(process.argv[1])) await cli(process.argv.slice(2))',
      ].join("\n"),
    },
  })
  return result.outputFiles[0]!.text
}

/**
 * The library's type declarations, for merakcode-adapter.d.mts beside the library: a TypeScript adapter that imports
 * ./merakcode-adapter.mjs gets them without installing anything
 */
export async function declarations() {
  const program = ts.createProgram([source], {
    declaration: true,
    emitDeclarationOnly: true,
    strict: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    esModuleInterop: true,
    types: ["node"],
  })
  let text = ""
  program.emit(program.getSourceFile(source), (_file, output) => (text = output), undefined, true)
  if (!text) throw new Error(`No declarations were emitted for ${source}`)
  return text
}

/** A built-in adapter as it is, importing the library beside it instead of the SDK */
async function example(name: string) {
  const file = path.join(adapters, `${name}.ts`)
  const code = (await Filesystem.readText(file)).replaceAll('"@merakcode/sdk/adapter"', '"./merakcode-adapter.mjs"')
  // A copy of the example runs on its own: it may use Node and the library, nothing else
  for (const [, specifier] of code.matchAll(/\bfrom\s+"([^"]+)"/g))
    if (!specifier!.startsWith("node:") && specifier !== "./merakcode-adapter.mjs")
      throw new Error(`${file} imports ${specifier}; an example may use only Node and the adapter library`)
  return `// MerakCode's own adapter, generated from packages/engine/src/agent-connection/adapters/${name}.ts. Do not edit.\n${code}`
}

/** Each generated file's path and text, formatted as the repo formats its code */
async function render() {
  const files: Record<string, string> = {
    "merakcode-adapter.mjs": `// MerakCode adapter library (member protocol). Generated from @merakcode/sdk/adapter; do not edit.\n${await bundle()}`,
    "merakcode-adapter.d.mts": `// Types of merakcode-adapter.mjs. Generated from @merakcode/sdk/adapter; do not edit.\n${await declarations()}`,
  }
  for (const [file, name] of Object.entries(EXAMPLES)) files[file] = await example(name)
  return Promise.all(
    Object.entries(files).map(async ([file, text]) => {
      const target = path.join(folder, file)
      return { target, text: await format(text, { ...(await resolveConfig(target)), filepath: target }) }
    }),
  )
}

async function main() {
  const files = await render()
  if (process.argv.includes("--check")) {
    for (const { target, text } of files) {
      const current = await Filesystem.readText(target).catch(() => "")
      if (current.replaceAll("\r\n", "\n") === text) continue
      console.error(`${path.relative(root, target)} is out of date, run: pnpm generate:adapter-library`)
      process.exitCode = 1
    }
    return
  }
  for (const { target, text } of files) await Filesystem.write(target, text)
}

if (import.meta.main) await main()
