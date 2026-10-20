import { build } from "esbuild"
import { rm } from "node:fs/promises"
import path from "node:path"

/**
 * Bundles the main process into one ESM file (all dependencies included, so the installer has no node_modules) and
 * the preload into CJS (a sandboxed preload must be CommonJS). Electron 44 ships Node 24.
 */
const root = path.resolve(import.meta.dirname, "..")
const dist = path.join(root, "dist")
const watch = process.argv.includes("--watch")

export async function bundle(options: { minify?: boolean } = {}) {
  await rm(dist, { recursive: true, force: true })
  const common = {
    bundle: true,
    platform: "node" as const,
    target: "node24",
    external: ["electron"],
    sourcemap: "linked" as const,
    minify: options.minify,
    logLevel: "warning" as const,
    legalComments: "none" as const,
  }
  await Promise.all([
    build({
      ...common,
      entryPoints: { main: path.join(root, "src", "index.ts") },
      outdir: dist,
      format: "esm",
      outExtension: { ".js": ".js" },
      // Bundled CommonJS dependencies (electron-updater and others) still require built-in modules
      banner: {
        js: 'import { createRequire as __createRequire } from "node:module";const require = __createRequire(import.meta.url);',
      },
    }),
    build({
      ...common,
      entryPoints: { preload: path.join(root, "src", "preload.ts") },
      outdir: dist,
      format: "cjs",
      outExtension: { ".js": ".cjs" },
    }),
  ])
}

if (import.meta.main) {
  await bundle({ minify: !watch && process.argv.includes("--minify") })
  console.log(`main process built: ${path.relative(process.cwd(), dist) || dist}`)
}
