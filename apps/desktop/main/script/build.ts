import { build, context, type BuildOptions, type Metafile } from "esbuild"
import { cp, mkdir, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"

/**
 * Bundles the main process into one ESM file, copies the native SQLite runtime, and builds
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
    external: ["electron", "better-sqlite3"],
    sourcemap: "linked" as const,
    minify: options.minify,
    logLevel: "warning" as const,
    // esbuild drops license comments; package.ts lists the bundled packages in THIRD_PARTY_LICENSES.txt instead
    legalComments: "none" as const,
    // Metafile paths are relative to this directory
    absWorkingDir: root,
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

/** Builds both entries and returns the absolute paths of the source files whose code ended up in the output */
export async function bundle(options: { minify?: boolean } = {}) {
  await rm(dist, { recursive: true, force: true })
  const results = await Promise.all(entries(options).map((entry) => build({ ...entry, metafile: true })))
  const native = await nativeRuntime()
  return [...results.flatMap((result) => bundled(result.metafile)), ...native]
}

async function nativeRuntime() {
  const require = createRequire(import.meta.url)
  const sdk = createRequire(require.resolve("@merakcode/sdk"))
  const source = path.dirname(sdk.resolve("better-sqlite3/package.json"))
  const destination = path.join(dist, "node_modules", "better-sqlite3")
  await mkdir(destination, { recursive: true })
  await Promise.all(
    ["lib", "prebuilds", "package.json", "LICENSE"].map((name) =>
      cp(path.join(source, name), path.join(destination, name), { recursive: true }),
    ),
  )
  const sqlite = createRequire(path.join(source, "package.json"))
  const addon = path.dirname(sqlite.resolve("node-addon-api/package.json"))
  await cp(addon, path.join(dist, "node_modules", "node-addon-api"), { recursive: true })
  return [path.join(source, "lib", "index.js"), path.join(addon, "index.js")]
}

/** Inputs that contributed bytes to an output (tree-shaken files are left out); esbuild lists them relative to root */
function bundled(metafile: Metafile) {
  return Object.values(metafile.outputs).flatMap((output) =>
    Object.entries(output.inputs)
      .filter(([, input]) => input.bytesInOutput > 0)
      .map(([file]) => path.resolve(root, file)),
  )
}

/**
 * Builds, then rebuilds whenever a source changes; rebuilt runs after each later build without errors. Resolves once
 * the first build is done (rejects if it failed) with a function that stops watching.
 */
export async function watchBundle(rebuilt: () => void) {
  await rm(dist, { recursive: true, force: true })
  await nativeRuntime()
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
