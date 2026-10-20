/**
 * Runs TypeScript sources directly on Node during development: `node --import ./script/node/register.mjs <entry.ts>`.
 * Tests use it too when spawning source files (server fixtures, etc.). Release builds are bundled JS and need none.
 *
 * - TypeScript (including namespaces) and extensionless relative imports: handled by tsx
 * - text imports (.txt, or `with { type: "text" }`): exported as strings
 * - the terminal UI's Solid JSX (.tsx) and Solid's client build: see solid.mjs
 */
import { readFileSync } from "node:fs"
import { registerHooks } from "node:module"
import { fileURLToPath } from "node:url"
import { register } from "tsx/esm/api"
import { compile, runtime, terminal } from "./solid.mjs"

// Do not inherit verbatimModuleSyntax from the package tsconfigs: it keeps type-only imports, and the extra import
// edges form cycles where module top-level code reads exports that are not initialized yet
register({ tsconfig: process.env.MERAKCODE_TSCONFIG ?? fileURLToPath(new URL("./tsconfig.json", import.meta.url)) })

registerHooks({
  resolve(specifier, context, next) {
    return next(runtime[specifier] ?? specifier, context)
  },
  load(url, context, next) {
    if (url.endsWith(".txt") || context.importAttributes?.type === "text") {
      return {
        format: "module",
        source: `export default ${JSON.stringify(readFileSync(new URL(url), "utf8"))}`,
        shortCircuit: true,
      }
    }
    const file = url.startsWith("file:") ? fileURLToPath(url) : undefined
    if (!file || !terminal(file)) return next(url, context)
    return { format: "module", source: compile(readFileSync(file, "utf8"), file), shortCircuit: true }
  },
})
