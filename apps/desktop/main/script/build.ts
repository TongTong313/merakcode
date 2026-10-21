import { build, context, type BuildOptions } from "esbuild"
import { rm } from "node:fs/promises"
import path from "node:path"

/**
 * Bundles the main process into one ESM file (all dependencies included, so the installer has no node_modules) and
 * the preload into CJS (a sandboxed preload must be CommonJS). Electron 44 ships Node 24.
 */
const root = path.resolve(import.meta.dirname, "..")
const dist = path.join(root, "dist")
const watch = process.argv.includes("--watch")

function entries(options: { minify?: boolean }): BuildOptions[] {
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
  return [
    {
      ...common,
      entryPoints: { main: path.join(root, "src", "index.ts") },
      outdir: dist,
      format: "esm",
      outExtension: { ".js": ".js" },
      // Bundled CommonJS dependencies (electron-updater and others) still require built-in modules
      banner: {
        js: 'import { createRequire as __createRequire } from "node:module";const require = __createRequire(import.meta.url);',
      },
    },
    {
      ...common,
      entryPoints: { preload: path.join(root, "src", "preload.ts") },
      outdir: dist,
      format: "cjs",
      outExtension: { ".js": ".cjs" },
    },
  ]
}

export async function bundle(options: { minify?: boolean } = {}) {
  await rm(dist, { recursive: true, force: true })
  await Promise.all(entries(options).map((entry) => build(entry)))
}

/**
 * Builds, then rebuilds whenever a source changes; rebuilt runs after each later build without errors. Resolves once
 * the first build is done (rejects if it failed) with a function that stops watching.
 */
export async function watchBundle(rebuilt: () => void) {
  await rm(dist, { recursive: true, force: true })
  const first: Promise<boolean>[] = []
  const contexts = await Promise.all(
    entries({}).map((entry) => {
      let done!: (ok: boolean) => void
      first.push(new Promise((resolve) => (done = resolve)))
      let initial = true
      return context({
        ...entry,
        plugins: [
          {
            name: "merakcode:rebuilt",
            setup(build) {
              build.onEnd((result) => {
                const ok = result.errors.length === 0
                if (initial) {
                  initial = false
                  return done(ok)
                }
                if (ok) rebuilt()
              })
            },
          },
        ],
      })
    }),
  )
  await Promise.all(contexts.map((item) => item.watch()))
  const stop = () => Promise.all(contexts.map((item) => item.dispose())).then(() => {})
  if ((await Promise.all(first)).includes(false)) {
    await stop()
    throw new Error("the main process does not build")
  }
  return stop
}

if (import.meta.main) {
  await bundle({ minify: !watch && process.argv.includes("--minify") })
  console.log(`main process built: ${path.relative(process.cwd(), dist) || dist}`)
}
