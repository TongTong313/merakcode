import type { DesktopBridge } from "../desktop/bridge-contract"

declare global {
  interface Window {
    __MERAKCODE_DESKTOP__?: DesktopBridge
  }
}

/** Bridge injected by the main-process preload; absent when opened in a plain browser (dev preview only) */
export const bridge = window.__MERAKCODE_DESKTOP__

export const mac = (bridge?.os ?? (navigator.platform.toLowerCase().includes("mac") ? "macos" : "windows")) === "macos"

/**
 * Persisted UI settings, kept in the app data directory so they survive backend port changes; falls back to
 * localStorage without a bridge
 */
export const storage = {
  async get<T>(key: string, fallback: T): Promise<T> {
    const raw = bridge ? await bridge.storageGet("ui", key).catch(() => null) : localStorage.getItem(`ui:${key}`)
    if (raw === null) return fallback
    try {
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  },
  set(key: string, value: unknown) {
    const raw = JSON.stringify(value)
    if (bridge) return bridge.storageSet("ui", key, raw).catch(() => {})
    localStorage.setItem(`ui:${key}`, raw)
  },
}

/** Writes to the main-process log; renderer diagnostics do not use console */
export function log(level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) {
  void bridge?.log(level, "renderer", message, extra).catch(() => {})
}
