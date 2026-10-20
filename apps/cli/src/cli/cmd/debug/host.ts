import { Exit } from "../../shutdown"

let registered = false

/** Loads the engine only when a debug command actually runs, so other commands start without it */
export async function host() {
  const { EngineHost } = await import("@merakcode/engine/host")
  if (!registered) Exit.register(EngineHost.cleanup)
  registered = true
  return EngineHost
}
