import { existsSync } from "node:fs"
import path from "node:path"

/**
 * Where the engine (local backend) lives and how to run it.
 *
 * The installer ships the Go binary under resources/merak. Development uses the native target built in merak/dist.
 */
export namespace Engine {
  export type Layout = { kind: "packaged"; root: string } | { kind: "source"; repo: string }

  /** The engine directory under resources when packaged; the repository root in development */
  export function layout(input: {
    packaged: boolean
    resources: string
    here: string
    env: NodeJS.ProcessEnv
  }): Layout {
    if (input.packaged) return { kind: "packaged", root: path.join(input.resources, "merak") }
    // The built main process lives in apps/desktop/main/dist, so the repository root is four levels up
    const repo = path.resolve(input.here, "../../../..")
    return { kind: "source", repo }
  }

  /** Command prefix that runs the CLI, followed by a subcommand such as serve */
  export function command(layout: Layout, platform = process.platform, arch = process.arch): string[] {
    const name = platform === "win32" ? "merak.exe" : "merak"
    if (layout.kind === "packaged") return [path.join(layout.root, name)]
    const target = `${platform === "win32" ? "windows" : platform}-${arch}`
    return [path.join(layout.repo, "merak", "dist", target, name)]
  }

  /** Built desktop UI: resources/app-dist in the installer, the renderer's dist in development */
  export function appDist(layout: Layout, resources: string) {
    if (layout.kind === "packaged") return path.join(resources, "app-dist")
    return path.join(layout.repo, "apps", "desktop", "renderer", "dist")
  }

  /** Lists missing files up front, which is clearer than a child process failing and a log to read */
  export function missing(layout: Layout, resources: string, env: NodeJS.ProcessEnv = {}): string[] {
    const files = [command(layout)[0]!]
    // script/dev.ts serves the UI from the Vite dev server (MERAKCODE_APP_DEV_URL), so nothing has to be built
    const ui =
      layout.kind === "source" && env.MERAKCODE_APP_DEV_URL ? [] : [path.join(appDist(layout, resources), "index.html")]
    return [...files, ...ui].filter((file) => !existsSync(file))
  }
}
