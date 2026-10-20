/**
 * Builds the release packages: one directory per target platform, laid out like directory-style releases such as the
 * Cursor CLI:
 *
 *   merakcode-<version>-<os>-<arch>/
 *     bin/   launcher script merak (merak.cmd on Windows)
 *     node/  bundled Node (node and npm from the official distribution, in the official layout: the engine finds npm
 *            through it)
 *     lib/   bundled JS and the dependencies that cannot be bundled (node_modules/)
 *
 * The JS is platform-independent and bundled once; each platform only swaps Node and the native dependencies.
 *
 * Usage (in apps/cli): pnpm build [--single] [--target linux-x64 ...] [--archive]
 *   --single   build only the host platform
 *   --target   build only the given platforms (one or more)
 *   --archive  also pack .tar.gz / .zip archives and write SHA256SUMS
 * MERAKCODE_NODE_MIRROR overrides the Node download source (default https://nodejs.org/dist)
 */
import { build, type Plugin } from "esbuild"
import { createHash } from "node:crypto"
import { createReadStream, existsSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { compile, runtime, terminal } from "../../../script/node/solid.mjs"
import { Archive } from "../../../script/lib/archive"
import * as Licenses from "../../../script/lib/licenses"
import { commandName } from "../bin/cli-name.cjs"
import { Filesystem } from "@merakcode/util/filesystem"
import { Project } from "@merakcode/util/project"
import { Process } from "@merakcode/util/process"

const dir = path.resolve(import.meta.dirname, "..")
const root = path.resolve(dir, "../..")
const pkg = await Filesystem.readJson(path.join(dir, "package.json"))
const version: string = pkg.version
// Stable releases use the "latest" channel; prereleases (0.2.0-beta.1) use their tag, and upgrade checks follow it
const channel = version.match(/-([a-z]+)/)?.[1] ?? "latest"
const nodeVersion = "26.12.0"
const mirror = process.env.MERAKCODE_NODE_MIRROR ?? "https://nodejs.org/dist"

type Target = { os: "linux" | "darwin" | "win32"; arch: "x64" | "arm64" }
const targets: Target[] = [
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "darwin", arch: "arm64" },
  { os: "win32", arch: "x64" },
  { os: "win32", arch: "arm64" },
]
/** Platform name in package and archive names: "windows" instead of npm's os value win32 */
const platform = (target: Target) => `${target.os === "win32" ? "windows" : target.os}-${target.arch}`

/**
 * Dependencies kept out of the bundle and installed as-is into lib/node_modules: native modules (they differ per
 * platform) and packages that locate their own wasm, workers or helper programs by path.
 * @napi-rs/canvas is not bundled either, but it is not shipped: it is downloaded the first time PDF rendering needs it
 * (see engine util/canvas-native.ts)
 */
const shipped = [
  "@opentui/core",
  "@lydell/node-pty",
  "@parcel/watcher",
  "pdfjs-dist",
  "web-tree-sitter",
  "tree-sitter-bash",
  "clipboardy",
  "open",
  // The SDK client loads it by name at runtime (to keep it out of the web bundle), so the bundler cannot resolve it;
  // the engine and the SDK share this copy
  "undici",
]

/** Runtime files to keep from shipped dependencies. Unlisted packages only lose generic junk files (see prune) */
const keep: Record<string, string[]> = {
  // Only its grammar wasm is used (see engine tool/bash.ts)
  "tree-sitter-bash": ["package.json", "LICENSE", "tree-sitter-bash.wasm"],
  // Only the legacy build and its worker, plus CMaps, standard fonts, image-decoding wasm and color profiles (see
  // engine util/pdfjs-runtime.ts). Node supports WebAssembly, so the pure-JS wasm fallbacks and the quickjs that runs
  // scripts inside PDFs are not needed
  "pdfjs-dist": [
    "package.json",
    "LICENSE",
    "legacy/build/pdf.mjs",
    "legacy/build/pdf.worker.mjs",
    "cmaps",
    "standard_fonts",
    "iccs",
    ...["jbig2.wasm", "openjpeg.wasm", "qcms_bg.wasm"].map((file) => `wasm/${file}`),
    ...["JBIG2", "OPENJPEG", "QCMS", "PDFJS_JBIG2", "PDFJS_OPENJPEG", "PDFJS_QCMS"].map(
      (name) => `wasm/LICENSE_${name}`,
    ),
  ],
  "web-tree-sitter": ["package.json", "LICENSE", "web-tree-sitter.js", "web-tree-sitter.cjs", "web-tree-sitter.wasm"],
}
/** Files no package needs at runtime: source maps, debug symbols, type declarations, docs */
const junk = /(\.map|\.pdb|\.d\.[mc]?ts|^(README|CHANGELOG|CODE_OF_CONDUCT|CONTRIBUTING)(\.md)?)$/i

async function prune(modules: string) {
  for (const [name, files] of Object.entries(keep)) {
    const dir = path.join(modules, name)
    if (!existsSync(dir)) continue
    const kept = path.join(modules, ".kept")
    for (const file of files) await fs.cp(path.join(dir, file), path.join(kept, file), { recursive: true })
    await fs.rm(dir, { recursive: true })
    await fs.rename(kept, dir)
  }
  for (const entry of await fs.readdir(modules, { recursive: true, withFileTypes: true }))
    if (entry.isFile() && junk.test(entry.name)) await fs.rm(path.join(entry.parentPath, entry.name))
}

/**
 * Plugins doing what the source loader does in development: Solid JSX for the terminal UI, the Solid client build and
 * text imports
 */
const plugins: Plugin[] = [
  {
    name: "terminal-solid",
    setup(build) {
      build.onLoad({ filter: /\.tsx$/ }, async (args) => {
        if (!terminal(args.path)) return
        return { contents: compile(await fs.readFile(args.path, "utf8"), args.path), loader: "js" }
      })
      build.onResolve({ filter: /^solid-js(\/store)?$/ }, (args) =>
        build.resolve((runtime as Record<string, string>)[args.path]!, {
          kind: args.kind,
          resolveDir: args.resolveDir,
        }),
      )
    },
  },
  {
    name: "text",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) =>
        args.with.type === "text" ? { path: path.resolve(args.resolveDir, args.path), namespace: "text" } : undefined,
      )
      build.onLoad({ filter: /.*/, namespace: "text" }, async (args) => ({
        contents: await fs.readFile(args.path, "utf8"),
        loader: "text",
      }))
    },
  },
]

/** Bundles the JS (platform-independent) */
async function bundle(out: string) {
  await fs.rm(out, { recursive: true, force: true })
  await build({
    entryPoints: {
      main: path.join(dir, "src/index.ts"),
      // Linux sandbox helper, started as its own process (see packages/sandbox/src/linux/index.ts)
      "sandbox-linux": path.join(root, "packages/sandbox/src/linux/exec.ts"),
    },
    outdir: out,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    // Prefer the ESM entry: some packages (jsonc-parser) have a UMD main that dynamically requires its own files,
    // which cannot be found once bundled
    mainFields: ["module", "main"],
    // Drop type-only imports like the source loader and tests do: the extra import edges would form cycles
    // (see script/node/register.mjs)
    tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: false } },
    target: "node26",
    // Flat output: every module's import.meta.dirname is lib/, so relative Worker paths resolve
    entryNames: "[name]",
    chunkNames: "[name]-[hash]",
    external: [...shipped, "@napi-rs/canvas"],
    loader: { ".txt": "text" },
    plugins,
    // Bundled CommonJS dependencies use __dirname / __filename, which ESM lacks. Only undeclared references are
    // replaced, so modules that declare variables with these names are unaffected
    define: {
      MERAKCODE_VERSION: JSON.stringify(version),
      MERAKCODE_CHANNEL: JSON.stringify(channel),
      // PDF rendering downloads this canvas version the first time it needs it (see engine util/canvas-native.ts)
      MERAKCODE_CANVAS_VERSION: JSON.stringify((await installed("@napi-rs/canvas")).version),
      __dirname: "import.meta.dirname",
      __filename: "import.meta.filename",
    },
    // esbuild looks for a global require when CommonJS dependencies require built-ins or external packages
    banner: {
      js: `import { createRequire as __merakcodeRequire } from "node:module"\nconst require = __merakcodeRequire(import.meta.url)`,
    },
    legalComments: "none",
    logLevel: "warning",
  })
  // Entry: lib/index.js in the package (the launcher looks for this name). It enables Node's compile cache before
  // loading the real code, so later starts skip recompiling tens of megabytes of JS
  for (const [name, main] of [["index", "main"]])
    await Filesystem.write(
      path.join(out, `${name}.js`),
      `import { enableCompileCache } from "node:module"\nenableCompileCache()\nawait import("./${main}.js")\n`,
    )
  // The output is ESM: without "type", Node first parses it as CommonJS, retries, and prints a warning
  await Filesystem.write(path.join(out, "package.json"), JSON.stringify({ type: "module" }, null, 2) + "\n")
  // esbuild drops license comments (legalComments: "none"); ship the full list of bundled packages instead
  const workspaces = ["apps/cli", "packages/engine", "packages/sdk/js", "packages/util", "packages/log"]
  await Filesystem.write(
    path.join(out, "THIRD_PARTY_LICENSES.txt"),
    Licenses.collect(workspaces.map((dir) => path.join(root, dir))),
  )
}

async function exec(cmd: string[], cwd?: string) {
  const code = await Process.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" }).exited
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited with ${code}`)
}

async function sha256(file: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

/**
 * Official Node distribution: downloaded, verified against the official SHASUMS256, extracted and cached under
 * .cache/node at the repo root
 */
async function node(target: Target) {
  const name = `node-v${nodeVersion}-${target.os === "win32" ? "win" : target.os}-${target.arch}`
  const file = `${name}.${target.os === "win32" ? "zip" : "tar.gz"}`
  const cache = path.join(root, ".cache", "node")
  const extracted = path.join(cache, name)
  if (existsSync(extracted)) return extracted
  await fs.mkdir(cache, { recursive: true })
  const base = `${mirror}/v${nodeVersion}`
  const sums = await fetch(`${base}/SHASUMS256.txt`).then((res) => res.text())
  const expected = sums
    .split("\n")
    .find((line) => line.trim().endsWith(`  ${file}`))
    ?.split(/\s+/)[0]
  if (!expected) throw new Error(`${file} is not listed in SHASUMS256.txt`)
  console.log(`Downloading ${file}`)
  const response = await fetch(`${base}/${file}`)
  if (!response.ok) throw new Error(`Downloading ${file} failed: ${response.status}`)
  const archive = path.join(cache, file)
  await fs.writeFile(archive, Buffer.from(await response.arrayBuffer()))
  if ((await sha256(archive)) !== expected) throw new Error(`${file} checksum mismatch`)
  await Archive.extract(archive, cache)
  await fs.rm(archive)
  return extracted
}

/** Copies node and npm from the official Node distribution into out/node, keeping the official layout */
async function copyNode(target: Target, out: string) {
  const source = await node(target)
  const files =
    target.os === "win32"
      ? ["node.exe", "node_modules/npm", "LICENSE"]
      : ["bin/node", "lib/node_modules/npm", "LICENSE"]
  for (const file of files) await fs.cp(path.join(source, file), path.join(out, file), { recursive: true })
}

/**
 * Version of a dependency installed in the workspace packages (pnpm links each package's direct dependencies); the
 * whole repo must use a single version
 */
async function installed(name: string) {
  const workspaces = [
    dir,
    ...(await fs.readdir(path.join(root, "packages"))).map((p) => path.join(root, "packages", p)),
  ]
  const found = new Map<string, string>()
  for (const workspace of workspaces) {
    const location = path.join(workspace, "node_modules", name)
    if (!existsSync(path.join(location, "package.json"))) continue
    found.set((await Filesystem.readJson(path.join(location, "package.json"))).version, await fs.realpath(location))
  }
  if (found.size !== 1)
    throw new Error(
      `${name}: expected one version in the workspaces, found ${found.size}: ${[...found.keys()].join(", ")}`,
    )
  const [[found_version, location]] = [...found]
  return { version: found_version!, location: location! }
}

/** Dependency patches declared in pnpm-workspace.yaml: name@version → patch file */
async function patches() {
  const text = await Filesystem.readText(path.join(root, "pnpm-workspace.yaml"))
  const block = text.slice(text.indexOf("\npatchedDependencies:\n")).split("\n\n")[0]!
  return [...block.matchAll(/^ {2}"?(.+?)"?: (.+)$/gm)].map(([, spec, file]) => {
    const at = spec!.lastIndexOf("@")
    return { name: spec!.slice(0, at), version: spec!.slice(at + 1), file: path.join(root, file!) }
  })
}

/** Installs lib/node_modules: only the shipped packages and their dependencies, with the target's native packages */
async function dependencies(target: Target, lib: string) {
  const versions = Object.fromEntries(
    await Promise.all(shipped.map(async (name) => [name, (await installed(name)).version] as const)),
  )
  const manifest = path.join(lib, "package.json")
  const own = await Filesystem.readJson(manifest)
  await Filesystem.write(manifest, JSON.stringify({ ...own, dependencies: versions }, null, 2) + "\n")
  const npm = path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")
  await exec(
    [
      process.execPath,
      existsSync(npm) ? npm : path.join(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
      "install",
      "--omit=dev",
      // Install scripts only compile native modules on the host; the release uses prebuilt binaries per platform
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      // Skip peer dependencies: bun-ffi-structs lists typescript as a peer, which is never used at runtime
      "--legacy-peer-deps",
      `--os=${target.os}`,
      `--cpu=${target.arch}`,
      ...(target.os === "linux" ? ["--libc=glibc"] : []),
    ],
    lib,
  )
  await Filesystem.write(manifest, JSON.stringify(own, null, 2) + "\n")
  // pdfjs-dist lists canvas as an optional dependency, so npm installs it; the release leaves it out and downloads it
  // on first use
  await fs.rm(path.join(lib, "node_modules", "@napi-rs"), { recursive: true, force: true })
  // npm ignores pnpm patches: copy the patched files from the locally installed (patched) package of the same version
  for (const patch of (await patches()).filter((item) => item.name in versions)) {
    if (patch.version !== versions[patch.name])
      throw new Error(`${patch.name}: patch version ${patch.version} does not match the installed version`)
    const { location } = await installed(patch.name)
    const files = [...(await Filesystem.readText(patch.file)).matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]!.trim())
    for (const file of files)
      await fs.copyFile(path.join(location, file), path.join(lib, "node_modules", patch.name, file))
  }
  await prune(path.join(lib, "node_modules"))
}

/** Launcher: runs lib/index.js with the bundled Node. node:ffi prints an ExperimentalWarning on every start. */
function launcher(target: Target) {
  if (target.os === "win32")
    return {
      name: `${commandName}.cmd`,
      text: [
        "@echo off",
        "setlocal",
        `"%~dp0..\\node\\node.exe" --disable-warning=ExperimentalWarning "%~dp0..\\lib\\index.js" %*`,
        "",
      ].join("\r\n"),
    }
  return {
    name: commandName,
    text: [
      "#!/bin/sh",
      // Installed commands are symlinks to this script: resolve the real file, then locate the install directory
      `self=$0`,
      `while [ -L "$self" ]; do`,
      `  link=$(readlink "$self")`,
      `  case $link in`,
      `    /*) self=$link ;;`,
      `    *) self=$(dirname "$self")/$link ;;`,
      `  esac`,
      `done`,
      `home=$(cd "$(dirname "$self")/.." && pwd)`,
      `exec "$home/node/bin/node" --disable-warning=ExperimentalWarning "$home/lib/index.js" "$@"`,
      "",
    ].join("\n"),
  }
}

async function assemble(target: Target, lib: string, out: string) {
  const name = `merakcode-${platform(target)}`
  console.log(`Assembling ${name}`)
  await fs.rm(out, { recursive: true, force: true })
  await fs.cp(lib, path.join(out, "lib"), { recursive: true })
  await dependencies(target, path.join(out, "lib"))
  await copyNode(target, path.join(out, "node"))
  const script = launcher(target)
  await Filesystem.write(path.join(out, "bin", script.name), script.text)
  await fs.chmod(path.join(out, "bin", script.name), 0o755)
  // Also the npm platform package: the main merakcode package installs only the one matching os/cpu
  await Filesystem.write(
    path.join(out, "package.json"),
    JSON.stringify(
      {
        name,
        version,
        description: `MerakCode for ${platform(target)}`,
        license: pkg.license,
        repository: pkg.repository,
        os: [target.os],
        cpu: [target.arch],
        ...(target.os === "linux" ? { libc: ["glibc"] } : {}),
      },
      null,
      2,
    ) + "\n",
  )
  await fs.copyFile(path.join(root, "LICENSE"), path.join(out, "LICENSE"))
  await fs.copyFile(path.join(root, "THIRD_PARTY_NOTICES.md"), path.join(out, "THIRD_PARTY_NOTICES.md"))
}

const selected = (() => {
  const index = process.argv.indexOf("--target")
  if (index >= 0) {
    const names = process.argv.slice(index + 1).filter((arg) => !arg.startsWith("--"))
    const picked = targets.filter((target) => names.includes(platform(target)))
    if (picked.length !== names.length)
      throw new Error(`Unknown platform: ${names.join(" ")} (available: ${targets.map(platform).join(" ")})`)
    return picked
  }
  if (process.argv.includes("--single"))
    return targets.filter((t) => t.os === process.platform && t.arch === process.arch)
  return targets
})()

const dist = path.join(dir, "dist")
const lib = path.join(dist, "lib")
console.log(`Building merakcode ${version} (${channel}): ${selected.map(platform).join(" ")}`)

await bundle(lib)

const archives: string[] = []
for (const target of selected) {
  const out = path.join(dist, `merakcode-${version}-${platform(target)}`)
  await assemble(target, lib, out)
  if (target.os === process.platform && target.arch === process.arch) {
    const bin = path.join(out, "bin", launcher(target).name)
    const result = await Process.run(target.os === "win32" ? ["cmd", "/c", bin, "--version"] : [bin, "--version"])
    if (result.text().trim() !== version)
      throw new Error(`Smoke test failed: --version printed ${result.text().trim()}`)
    console.log(`Smoke test passed: ${version}`)
  }
  if (!process.argv.includes("--archive")) continue
  const archive = `${out}.${target.os === "win32" ? "zip" : "tar.gz"}`
  await Archive.create(out, archive)
  archives.push(archive)
}

if (archives.length) {
  const lines = await Promise.all(archives.map(async (file) => `${await sha256(file)}  ${path.basename(file)}`))
  await Filesystem.write(path.join(dist, "SHA256SUMS"), lines.join("\n") + "\n")
  // The one-line install scripts ship with each release: releases/latest/download/install.sh is always the newest
  for (const script of ["install.sh", "install.ps1"]) {
    const text = await Filesystem.readText(path.join(root, "script/install", script))
    await Filesystem.write(path.join(dist, script), text.replaceAll("{{REPOSITORY}}", Project.REPOSITORY))
  }
  console.log(`Wrote ${archives.length} archives, SHA256SUMS and install scripts`)
}
