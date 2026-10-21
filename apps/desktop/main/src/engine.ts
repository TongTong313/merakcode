import { existsSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

/**
 * Where the engine (local backend) lives and how to run it.
 *
 * The installer ships the same release bundle as the CLI (resources/engine: a bundled Node plus lib/), and the main
 * process starts `serve` from it. Electron's built-in Node is older and lacks node:ffi, so it cannot run the engine.
 * In development there is no bundle: node on PATH (or MERAKCODE_DESKTOP_NODE) runs the apps/cli sources through the
 * source loader.
 */
export namespace Engine {
  export type Layout = { kind: "packaged"; root: string } | { kind: "source"; repo: string; node: string }

  /** The engine directory under resources when packaged; the repository root in development */
  export function layout(input: {
    packaged: boolean
    resources: string
    here: string
    env: NodeJS.ProcessEnv
  }): Layout {
    if (input.packaged) return { kind: "packaged", root: path.join(input.resources, "engine") }
    // The built main process lives in apps/desktop/main/dist, so the repository root is four levels up
    const repo = path.resolve(input.here, "../../../..")
    return { kind: "source", repo, node: input.env.MERAKCODE_DESKTOP_NODE || "node" }
  }

  /** Command prefix that runs the CLI, followed by a subcommand such as serve */
  export function command(layout: Layout, platform = process.platform): string[] {
    // node:ffi is still experimental and every process would print a warning
    const quiet = "--disable-warning=ExperimentalWarning"
    if (layout.kind === "packaged") {
      const node = path.join(layout.root, "node", platform === "win32" ? "node.exe" : path.join("bin", "node"))
      return [node, quiet, path.join(layout.root, "lib", "index.js")]
    }
    const loader = pathToFileURL(path.join(layout.repo, "script", "node", "register.mjs")).href
    const entry = path.join(layout.repo, "apps", "cli", "src", "index.ts")
    return [layout.node, "--import", loader, quiet, entry]
  }

  /** Built desktop UI: resources/app-dist in the installer, the renderer's dist in development */
  export function appDist(layout: Layout, resources: string) {
    if (layout.kind === "packaged") return path.join(resources, "app-dist")
    return path.join(layout.repo, "apps", "desktop", "renderer", "dist")
  }

  /** Lists missing files up front, which is clearer than a child process failing and a log to read */
  export function missing(layout: Layout, resources: string, env: NodeJS.ProcessEnv = {}): string[] {
    const files =
      layout.kind === "packaged"
        ? [command(layout)[0]!, path.join(layout.root, "lib", "index.js")]
        : [path.join(layout.repo, "apps", "cli", "src", "index.ts")]
    // script/dev.ts serves the UI from the Vite dev server (MERAKCODE_APP_DEV_URL), so nothing has to be built
    const ui =
      layout.kind === "source" && env.MERAKCODE_APP_DEV_URL ? [] : [path.join(appDist(layout, resources), "index.html")]
    return [...files, ...ui].filter((file) => !existsSync(file))
  }
}
