/**
 * In-app routes loaded by windows. Matches the renderer routes: `/:dir/session/:id?`, where dir is the base64url of
 * the directory (same as base64Encode in packages/util: URL-safe characters, no padding).
 */
export namespace Route {
  export function of(opts: { directory?: string; sessionID?: string } = {}) {
    if (!opts.directory) return "/"
    const binary = Array.from(new TextEncoder().encode(opts.directory), (b) => String.fromCharCode(b)).join("")
    const dir = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
    return opts.sessionID ? `/${dir}/session/${encodeURIComponent(opts.sessionID)}` : `/${dir}/session`
  }

  /** Project directory a window shows (decoded from the first path segment); undefined for the home page and others */
  export function directory(url: string) {
    const segment = (() => {
      try {
        return new URL(url).pathname.split("/")[1]
      } catch {
        return undefined
      }
    })()
    if (!segment) return
    try {
      const b64 = segment.replace(/-/g, "+").replace(/_/g, "/")
      const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))
      return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
    } catch {
      return
    }
  }

  /** Deep link merakcode://open-project?directory=... (matches deep-links.ts in the renderer) */
  export function deepLink(input: string) {
    if (!input.startsWith("merakcode://")) return
    try {
      const url = new URL(input)
      if (url.hostname !== "open-project") return
      return url.searchParams.get("directory") || undefined
    } catch {
      return
    }
  }

  /** Spellings of one directory that differ in case, trailing slash or Windows backslashes are the same project */
  export function same(a: string, b: string, platform = process.platform) {
    const normalize = (value: string) => {
      const slashes = value.replace(/\\/g, "/").replace(/\/+$/, "")
      return platform === "win32" || platform === "darwin" ? slashes.toLowerCase() : slashes
    }
    return normalize(a) === normalize(b)
  }
}
