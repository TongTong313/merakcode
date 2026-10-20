/**
 * The engine's only entry point for programs that host it (the `merak serve`, `generate` and `debug` commands).
 * Everything else talks to the engine over HTTP through the SDK.
 */
import { closeParcelWatchers } from "../file/parcel-binding"
import { withInstance } from "./bootstrap"
import { openapi } from "./openapi"
import { serve, type NetworkArgs } from "./serve"

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
    agent: () => import("./debug/agent"),
    config: () => import("./debug/config"),
    file: () => import("./debug/file"),
    lsp: () => import("./debug/lsp"),
    process: () => import("./debug/process"),
    ripgrep: () => import("./debug/ripgrep"),
    scrap: () => import("./debug/scrap"),
    skill: () => import("./debug/skill"),
    snapshot: () => import("./debug/snapshot"),
  },
}
