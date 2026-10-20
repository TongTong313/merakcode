import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { bundle } from "./build"

/**
 * Starts the desktop app in development: builds the main process, builds the renderer if it has no output yet, then
 * opens Electron. The local backend runs the apps/cli sources with Node from PATH (see src/engine.ts).
 */
const root = path.resolve(import.meta.dirname, "..")
const renderer = path.resolve(root, "..", "renderer")
const require = createRequire(import.meta.url)

// The electron package runs no install script here, so download the Electron binary on first use (ELECTRON_MIRROR
// selects a mirror)
const binary = () => {
  try {
    return require("electron") as string
  } catch {
    return undefined
  }
}
if (!binary() || !existsSync(binary()!)) {
  const install = require.resolve("electron/install.js")
  const result = spawnSync(process.execPath, [install], { stdio: "inherit" })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (!existsSync(path.join(renderer, "dist", "index.html")) || process.argv.includes("--renderer")) {
  const vite = path.join(
    path.dirname(createRequire(path.join(renderer, "package.json")).resolve("vite/package.json")),
    "bin",
    "vite.js",
  )
  const result = spawnSync(process.execPath, [vite, "build"], {
    cwd: renderer,
    stdio: "inherit",
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

await bundle()
const child = spawn(binary()!, [root, ...process.argv.slice(2).filter((arg) => arg !== "--renderer")], {
  stdio: "inherit",
  // Terminals inside Electron apps such as VS Code pass on ELECTRON_RUN_AS_NODE, which turns Electron into plain Node
  env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "ELECTRON_RUN_AS_NODE")),
    MERAKCODE_DESKTOP_DEV: "1",
  },
})
child.on("exit", (code) => process.exit(code ?? 0))
