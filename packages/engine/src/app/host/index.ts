import { Global } from "../../infra/global"
/**
 * The engine's only entry point for programs that host it (the `merak serve`, `generate` and `debug` commands).
 * Everything else talks to the engine over HTTP through the SDK.
 */
import { closeParcelWatchers } from "../../infra/file/parcel-binding"
import { withInstance } from "./bootstrap"
import { openapi } from "./openapi"
import { serve, type NetworkArgs } from "./serve"

async function diagnostic<T>(load: () => Promise<T>) {
  await Global.initialize()
  return load()
}

export type { NetworkArgs }

export const EngineHost = {
  serve,
  openapi,
  withInstance,
  /**
   * Must run before the process exits: on Linux, exiting while file watchers are still subscribed
   * makes the watcher module free memory twice and the process crashes with code 134
   */
  cleanup: closeParcelWatchers,
  /** Developer diagnostics behind `merak debug`; each loads only when used */
  debug: {
    agent: () => diagnostic(() => import("./debug/agent")),
    config: () => diagnostic(() => import("./debug/config")),
    file: () => diagnostic(() => import("./debug/file")),
    lsp: () => diagnostic(() => import("./debug/lsp")),
    process: () => diagnostic(() => import("./debug/process")),
    ripgrep: () => diagnostic(() => import("./debug/ripgrep")),
    scrap: () => diagnostic(() => import("./debug/scrap")),
    skill: () => diagnostic(() => import("./debug/skill")),
    snapshot: () => diagnostic(() => import("./debug/snapshot")),
  },
}
