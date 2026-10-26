import { Project } from "@merakcode/util/project"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"
import * as Licenses from "../../../../script/lib/licenses"
import { bundle } from "./build"
import { merge } from "./update-manifest"

/**
 * Builds the desktop installers: NSIS on Windows, dmg on macOS (plus a zip for auto-update), AppImage and deb on
 * Linux.
 *
 * Each installer contains the Electron main process (bundled into one file), the UI (renderer/dist →
 * resources/app-dist) and the same release bundle as the CLI (the engine with its own Node → resources/engine).
 * The engine bundle is built into apps/cli/dist.
 *
 * Usage (in apps/desktop/main): pnpm package [--target windows-x64 ...]
 *   Without --target, builds for the host platform. Installers can only be built on their own OS (dmg needs macOS,
 *   AppImage and deb need Linux).
 * Environment: ELECTRON_MIRROR and ELECTRON_BUILDER_BINARIES_MIRROR change the download source.
 */
const root = path.resolve(import.meta.dirname, "..")
const repo = path.resolve(root, "../../..")
const renderer = path.resolve(root, "..", "renderer")
const cli = path.join(repo, "apps", "cli")
const require = createRequire(import.meta.url)

type Target = { os: "windows" | "darwin" | "linux"; arch: "x64" | "arm64" }

const host = (): Target => ({
  os: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux",
  arch: process.arch === "arm64" ? "arm64" : "x64",
})

const targets = (() => {
  const values = process.argv.flatMap((arg, index) => (arg === "--target" ? [process.argv[index + 1] ?? ""] : []))
  if (!values.length) return [host()]
  return values.map((value) => {
    const [os, arch] = value.split("-")
    if ((os !== "windows" && os !== "darwin" && os !== "linux") || (arch !== "x64" && arch !== "arm64"))
      throw new Error(`unknown target: ${value} (expected <windows|darwin|linux>-<x64|arm64>)`)
    return { os, arch } as Target
  })
})()

const run = (command: string, args: string[], cwd: string) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" })
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status})`)
}
const node = (script: string, args: string[], cwd: string) =>
  run(
    process.execPath,
    ["--import", pathToFileURL(path.join(repo, "script", "node", "register.mjs")).href, script, ...args],
    cwd,
  )

const version = (JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { version: string }).version
const electron = (JSON.parse(await readFile(require.resolve("electron/package.json"), "utf8")) as { version: string })
  .version

// 1. UI and main process
run(
  process.execPath,
  [
    path.join(
      path.dirname(createRequire(path.join(renderer, "package.json")).resolve("vite/package.json")),
      "bin",
      "vite.js",
    ),
    "build",
  ],
  renderer,
)
const bundled = await bundle({ minify: true })

// 2. Engine: rebuilt for every target so it matches the current code
node(
  "script/build.ts",
  targets.flatMap((target) => ["--target", `${target.os}-${target.arch}`]),
  cli,
)
for (const target of targets) {
  const dir = path.join(cli, "dist", `merakcode-${version}-${target.os}-${target.arch}`)
  if (!existsSync(path.join(dir, "lib", "index.js"))) throw new Error(`engine was not built: ${dir}`)
}

// 3. App directory for electron-builder: only the bundled main process and a package.json without dependencies
const stage = path.join(root, ".package")
const app = path.join(stage, "app")
await rm(stage, { recursive: true, force: true })
await mkdir(app, { recursive: true })
// Packages bundled into the window UI (its production dependencies) and into the main process (the files esbuild put
// into main.js and preload.cjs: they are all devDependencies). The engine ships its own list under resources/engine/lib
await writeFile(path.join(stage, "THIRD_PARTY_LICENSES.txt"), Licenses.collect([renderer], bundled))
for (const file of ["main.js", "preload.cjs"]) await cp(path.join(root, "dist", file), path.join(app, file))
await writeFile(
  path.join(app, "package.json"),
  JSON.stringify(
    {
      name: "merakcode-desktop",
      productName: Project.NAME,
      version,
      description: "MerakCode desktop app",
      license: "MIT",
      author: { name: Project.AUTHOR, email: Project.EMAIL },
      homepage: Project.HOMEPAGE,
      type: "module",
      main: "main.js",
      // Window app_id / WM_CLASS on Linux; must match the installed .desktop file name for the taskbar to group it
      desktopName: "merakcode-desktop.desktop",
    },
    null,
    2,
  ),
)

const [owner, name] = Project.REPOSITORY.split("/")
const { build, Platform, Arch } = await import("electron-builder")

const release = path.join(root, "release")
// macOS only updates itself when the app is signed (see src/update-policy.ts)
const signed = (target: Target) => target.os === "darwin" && !!process.env.CSC_LINK

for (const target of targets) {
  const engine = path.join(cli, "dist", `merakcode-${version}-${target.os}-${target.arch}`)
  await writeFile(path.join(stage, "build-info.json"), JSON.stringify({ signed: signed(target) }))
  const platform = { windows: Platform.WINDOWS, darwin: Platform.MAC, linux: Platform.LINUX }[target.os]
  const kinds = { windows: ["nsis"], darwin: ["dmg", "zip"], linux: ["AppImage", "deb"] }[target.os]
  const artifact = "MerakCode-${version}-" + `${target.os}-${target.arch}` + ".${ext}"
  await build({
    projectDir: app,
    targets: platform.createTarget(kinds, target.arch === "arm64" ? Arch.arm64 : Arch.x64),
    publish: "never",
    config: {
      appId: "dev.merakcode.desktop",
      productName: Project.NAME,
      copyright: `Copyright © ${Project.SINCE} ${Project.AUTHOR}`,
      electronVersion: electron,
      electronDownload: process.env.ELECTRON_MIRROR ? { mirror: process.env.ELECTRON_MIRROR } : undefined,
      // The UI is only Chinese and English, so skip Chromium's other locales (saves over 40 MB)
      electronLanguages: ["zh-CN", "en-US"],
      directories: { output: path.join(root, "release"), buildResources: path.resolve(root, "..", "build") },
      files: ["main.js", "preload.cjs", "package.json"],
      asar: true,
      npmRebuild: false,
      nodeGypRebuild: false,
      extraResources: [
        { from: engine, to: "engine" },
        { from: path.join(renderer, "dist"), to: "app-dist" },
        { from: path.resolve(root, "..", "build", "icon.png"), to: "icon.png" },
        { from: path.join(repo, "THIRD_PARTY_NOTICES.md"), to: "THIRD_PARTY_NOTICES.md" },
        { from: path.join(stage, "THIRD_PARTY_LICENSES.txt"), to: "THIRD_PARTY_LICENSES.txt" },
        { from: path.join(stage, "build-info.json"), to: "build-info.json" },
      ],
      // Disable unused entry points that could be abused to run arbitrary code
      electronFuses: {
        runAsNode: false,
        enableCookieEncryption: true,
        enableNodeOptionsEnvironmentVariable: false,
        enableNodeCliInspectArguments: false,
        onlyLoadAppFromAsar: true,
        grantFileProtocolExtraPrivileges: false,
      },
      protocols: [{ name: Project.NAME, schemes: ["merakcode"] }],
      publish: owner && name ? [{ provider: "github", owner, repo: name, releaseType: "release" }] : undefined,
      artifactName: artifact,
      win: { icon: "icon.png", signAndEditExecutable: true },
      nsis: {
        oneClick: true,
        perMachine: false,
        createDesktopShortcut: true,
        shortcutName: Project.NAME,
        deleteAppDataOnUninstall: false,
      },
      mac: {
        icon: "icon.png",
        category: "public.app-category.developer-tools",
        hardenedRuntime: true,
        // Without a Developer ID certificate (CSC_LINK) the app is unsigned: people allow it once in Privacy & Security
        identity: process.env.CSC_LINK ? undefined : null,
        notarize: !!process.env.CSC_LINK && !!process.env.APPLE_TEAM_ID,
      },
      dmg: { artifactName: artifact },
      linux: {
        icon: "icon.png",
        category: "Development",
        executableName: "merakcode-desktop",
        syncDesktopName: true,
        synopsis: "AI coding agent",
        maintainer: `${Project.AUTHOR} <${Project.EMAIL}>`,
      },
      deb: {
        // electron-builder's default dependencies plus two missing on a clean Ubuntu: ALSA for Electron and
        // libatomic1 for the engine's bundled Node. Ubuntu 24.04 renamed several libraries (t64 suffix); "new | old"
        // makes apt pick the real library. With plain libasound2, apt may choose liboss4-salsa-asound2, which also
        // "provides" libasound2 but lacks symbols, and Electron fails to start.
        depends: [
          "libgtk-3-0t64 | libgtk-3-0",
          "libnotify4",
          "libnss3",
          "libxss1",
          "libxtst6",
          "xdg-utils",
          "libatspi2.0-0t64 | libatspi2.0-0",
          "libuuid1",
          "libsecret-1-0",
          "libasound2t64 | libasound2",
          "libatomic1",
        ],
        // The UI defaults to Chinese, which shows as boxes on systems without CJK fonts (server or minimal installs);
        // apt installs recommended packages by default
        recommends: ["fonts-noto-cjk"],
      },
    },
  })
  // Each Mac build writes latest-mac.yml; keep this one aside so the next build does not overwrite it
  if (target.os === "darwin" && existsSync(path.join(release, "latest-mac.yml")))
    await rename(path.join(release, "latest-mac.yml"), path.join(release, `latest-mac-${target.arch}.yml`))
}

const manifests = targets
  .filter((target) => target.os === "darwin")
  .map((target) => path.join(release, `latest-mac-${target.arch}.yml`))
  .filter((file) => existsSync(file))
if (manifests.length) {
  const texts = await Promise.all(manifests.map((file) => readFile(file, "utf8")))
  await writeFile(path.join(release, "latest-mac.yml"), texts.slice(1).reduce(merge, texts[0]!))
  for (const file of manifests) await rm(file)
}

console.log(`installers in ${path.relative(process.cwd(), release) || "release"}`)
