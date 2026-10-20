import { defineConfig, type ViteUserConfig } from "vitest/config"
import type { PluginOption } from "vite"
import { text } from "./vitest-text.ts"

// On Windows --import only accepts file:// URLs, not drive-letter paths
const register = new URL("./register.mjs", import.meta.url).href

type Test = NonNullable<ViteUserConfig["test"]>

/**
 * Shared config for running each package's tests on Node:
 * - one process per test file: some tests overwrite module-level singletons (provider caches, etc.) and would
 *   pollute each other in a shared process
 * - tests spawn .ts fixtures and CLI sources with the current runtime, and children inherit process.execArgv, so
 *   test processes get the source loader; node:ffi is still experimental and warns in every process, so that
 *   warning is disabled too
 * - type-only imports are dropped, matching the runtime loader: the package tsconfigs enable verbatimModuleSyntax,
 *   and keeping those imports would create import cycles
 */
export function config(test: Test, plugins: PluginOption[] = []) {
  return defineConfig({
    plugins: [text(), ...plugins],
    // drop type-only imports despite verbatimModuleSyntax in tsconfig
    oxc: { typescript: { onlyRemoveTypeImports: false } },
    test: {
      pool: "forks",
      testTimeout: 30_000,
      hookTimeout: 30_000,
      execArgv: ["--import", register, "--disable-warning=ExperimentalWarning"],
      ...test,
    },
  })
}
