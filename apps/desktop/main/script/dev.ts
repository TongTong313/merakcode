import { Network } from "@merakcode/util/network"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { createServer } from "vite"
import { watchBundle } from "./build"

/**
 * Starts the desktop app in development and keeps it current while you edit:
 * - UI (apps/desktop/renderer): served by the Vite dev server. The backend forwards UI requests to it
 *   (MERAKCODE_APP_DEV_URL), so saved changes show up in the window at once and keep its state.
 * - Main process and preload: rebuilt on change, then the app restarts.
 * - Backend: runs the apps/cli sources with Node from PATH (see src/engine.ts). It is not restarted when they change,
 *   which would cut off a running conversation: Help › Restart Local Service starts it on the new sources, and windows
 *   reconnect on their own.
 * Arguments are passed on to Electron.
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

const port = await Network.freePort()
const vite = await createServer({
  root: renderer,
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    // Windows load the UI through the backend's address; the hot update socket connects to Vite directly
    ws: { host: "127.0.0.1", clientPort: port },
  },
})
await vite.listen()

let electron: ChildProcess | undefined
let restarting = false

const stopBundle = await watchBundle(() => {
  const child = electron
  if (!child?.connected || restarting) return
  restarting = true
  console.log("[dev] main process rebuilt, restarting the app")
  child.send("quit")
  // A message sent while the app is still starting can go unheard; killing it also stops its backend
  setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill(), 10_000)
})

const env = {
  // Terminals inside Electron apps such as VS Code pass on ELECTRON_RUN_AS_NODE, which turns Electron into plain Node
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "ELECTRON_RUN_AS_NODE")),
  MERAKCODE_DESKTOP_DEV: "1",
  MERAKCODE_APP_DEV_URL: `http://127.0.0.1:${port}`,
}

function launch() {
  const child = spawn(binary()!, [root, ...process.argv.slice(2)], {
    // The IPC channel carries the quit message (see src/index.ts)
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    env,
  })
  electron = child
  child.on("exit", (code) => {
    if (restarting) {
      restarting = false
      return launch()
    }
    void shutdown(code ?? 0)
  })
}

async function shutdown(code: number) {
  await Promise.allSettled([stopBundle(), vite.close()])
  process.exit(code)
}

launch()
