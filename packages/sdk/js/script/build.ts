/**
 * Builds the @merakcode/sdk package published to npm: one ESM bundle per public entry (with the repo's private
 * packages bundled in), plus type declarations. The engine comes from the CLI's platform packages, listed as optional
 * dependencies at the same version, so npm installs only the one for the current machine.
 *
 * Called by the CLI's pack.ts (which prepares it together with the platform packages and the main package); uses the
 * CLI's version.
 */
import { build as esbuild } from "esbuild"
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import ts from "typescript"

const root = path.resolve(import.meta.dirname, "..")

/** Public entries: subpath → source file (relative to src) */
const entries = {
  ".": "index.ts",
  "./client": "client/index.ts",
  "./errors": "errors.ts",
  "./store": "store/index.ts",
  "./process": "process/index.ts",
  "./plugin": "plugin/index.ts",
  "./transcript": "transcript/index.ts",
}

/** Runtime dependencies, published pinned to the exact versions installed in the repo */
const runtime = ["zod", "undici"]

function emitTypes(outdir: string) {
  const config = ts.getParsedCommandLineOfConfigFile(
    path.join(root, "tsconfig.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
      },
    },
  )!
  const program = ts.createProgram(
    Object.values(entries).map((file) => path.join(root, "src", file)),
    { ...config.options, declaration: true, emitDeclarationOnly: true, noEmit: false, outDir: outdir },
  )
  const result = program.emit()
  const errors = [...ts.getPreEmitDiagnostics(program), ...result.diagnostics].filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  )
  if (errors.length > 0)
    throw new Error(
      ts.formatDiagnostics(errors, {
        ...ts.sys,
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: () => root,
        getNewLine: () => "\n",
      }),
    )
}

export async function build(input: { outdir: string; version: string; platforms: string[] }) {
  await rm(input.outdir, { recursive: true, force: true })
  await mkdir(input.outdir, { recursive: true })
  const name = (subpath: string) => (subpath === "." ? "index" : subpath.slice(2))

  await esbuild({
    entryPoints: Object.fromEntries(
      Object.entries(entries).map(([subpath, file]) => [name(subpath), path.join(root, "src", file)]),
    ),
    outdir: path.join(input.outdir, "dist"),
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node24",
    external: runtime,
    chunkNames: "chunk-[hash]",
    logLevel: "warning",
  })
  emitTypes(path.join(input.outdir, "types"))

  const sdk = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
    name: string
    license: string
    repository: unknown
    homepage: string
    bugs: unknown
  }
  const require = createRequire(path.join(root, "package.json"))
  const installed = async (pkg: string) =>
    (JSON.parse(await readFile(require.resolve(`${pkg}/package.json`), "utf8")) as { version: string }).version
  const dependencies = Object.fromEntries(
    await Promise.all(runtime.map(async (pkg) => [pkg, await installed(pkg)] as const)),
  )
  const manifest = {
    name: sdk.name,
    version: input.version,
    description: "TypeScript SDK for the MerakCode coding agent",
    license: sdk.license,
    repository: sdk.repository,
    homepage: sdk.homepage,
    bugs: sdk.bugs,
    type: "module",
    engines: { node: ">=24" },
    exports: Object.fromEntries(
      Object.entries(entries).map(([subpath, file]) => [
        subpath,
        { types: `./types/${file.replace(/\.ts$/, ".d.ts")}`, default: `./dist/${name(subpath)}.js` },
      ]),
    ),
    files: ["dist", "types", "THIRD_PARTY_NOTICES.md"],
    dependencies,
    optionalDependencies: Object.fromEntries(input.platforms.map((platform) => [platform, input.version])),
  }
  await writeFile(path.join(input.outdir, "package.json"), JSON.stringify(manifest, null, 2) + "\n")
  await cp(path.join(root, "README.md"), path.join(input.outdir, "README.md"))
  await cp(path.join(root, "../../../LICENSE"), path.join(input.outdir, "LICENSE"))
  await cp(path.join(root, "../../../THIRD_PARTY_NOTICES.md"), path.join(input.outdir, "THIRD_PARTY_NOTICES.md"))
}
