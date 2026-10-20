/**
 * Solid JSX compilation for the terminal UI (apps/cli, opentui). Shared by the runtime loader (register.mjs) and the
 * Vitest plugin (vitest-solid.ts).
 *
 * opentui's own Solid preload only supports Bun, so Node compiles it here: Solid JSX is not React-style function
 * calls, and babel-preset-solid has to generate universal rendering code with the renderer from @opentui/solid.
 * Only .tsx files whose nearest tsconfig.json sets jsxImportSource to @opentui/solid are handled; the desktop app's
 * DOM Solid is compiled by Vite (vite-plugin-solid) and never comes through here.
 */
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { transformSync } from "@babel/core"
import ts from "@babel/preset-typescript"
import solid from "babel-preset-solid"

const SOURCE = "@opentui/solid"
const cache = new Map()

function source(dir) {
  if (cache.has(dir)) return cache.get(dir)
  const config = path.join(dir, "tsconfig.json")
  const text = existsSync(config) ? readFileSync(config, "utf8") : undefined
  const parent = path.dirname(dir)
  const found =
    text === undefined
      ? parent === dir
        ? undefined
        : source(parent)
      : text.match(/"jsxImportSource"\s*:\s*"([^"]+)"/)?.[1]
  cache.set(dir, found)
  return found
}

/** Whether the file should be compiled as opentui Solid JSX */
export function terminal(file) {
  return file.endsWith(".tsx") && !/[\\/]node_modules[\\/]/.test(file) && source(path.dirname(file)) === SOURCE
}

export function compile(code, file) {
  const result = transformSync(code, {
    filename: file,
    configFile: false,
    babelrc: false,
    sourceMaps: "inline",
    presets: [
      [solid, { moduleName: SOURCE, generate: "universal" }],
      // Drop type-only imports, for the same reason register.mjs disables verbatimModuleSyntax
      [ts, { onlyRemoveTypeImports: false }],
    ],
  })
  return result?.code ?? ""
}

/**
 * Solid's package entries use the "browser" condition to pick the client or server (SSR) build, and Node gets the
 * non-reactive server build by default. A global --conditions=browser is not an option: server dependencies such as
 * ws would switch to browser stubs too. Like the Node build of @opentui/solid, only Solid's own entries point to the
 * client build, so the whole process shares one copy of Solid.
 */
export const runtime = {
  "solid-js": "solid-js/dist/solid.js",
  "solid-js/store": "solid-js/store/dist/store.js",
}
