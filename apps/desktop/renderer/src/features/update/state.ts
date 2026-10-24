/**
 * The app's update state, built from the updater's events. Shared by the About page and the sidebar notice.
 */
import { createSignal } from "solid-js"
import type { UpdateEvent } from "../../desktop/bridge-contract"
import { bridge } from "../../lib/bridge"

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "latest" }
  | { kind: "available"; version: string }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "ready"; version: string }
  | { kind: "manual"; version: string; reason?: "linux-package" | "mac-unsigned" }
  | { kind: "unavailable"; reason: "disabled" }
  | { kind: "error"; code: string; message: string; version?: string }

const version = (state: UpdateState) => ("version" in state ? state.version : undefined)

export function reduce(state: UpdateState, event: UpdateEvent): UpdateState {
  // A download in progress or a finished one stays visible through the periodic checks
  const busy = state.kind === "downloading" || state.kind === "ready"
  if (event.type === "checking")
    return busy || state.kind === "available" || state.kind === "manual" ? state : { kind: "checking" }
  if (event.type === "latest") return busy ? state : { kind: "latest" }
  if (event.type === "available") return busy ? state : { kind: "available", version: event.version }
  if (event.type === "manual") return { kind: "manual", version: event.version, reason: event.reason }
  if (event.type === "unavailable") return busy ? state : { kind: "unavailable", reason: event.reason }
  if (event.type === "progress")
    return { kind: "downloading", version: version(state) ?? "", percent: Math.round(event.percent) }
  if (event.type === "downloaded") return { kind: "ready", version: event.version }
  const known = version(state)
  return { kind: "error", code: event.code, message: event.message, ...(known ? { version: known } : {}) }
}

const [state, setState] = createSignal<UpdateState>({ kind: "idle" })
let listening = false

/** Starts following the updater once; returns the current state */
export function updateState() {
  if (!listening && bridge) {
    listening = true
    bridge.onUpdate((event) => setState((current) => reduce(current, event)))
  }
  return state()
}
