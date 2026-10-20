import type { CliRenderer } from "@opentui/core"

export function destroyRenderer(renderer: Pick<CliRenderer, "isDestroyed" | "setTerminalTitle" | "destroy">) {
  // A destroyed renderer cannot set the terminal title (the native session is over and opentui throws InvalidPhase).
  if (renderer.isDestroyed) return
  renderer.setTerminalTitle("")
  renderer.destroy()
}
