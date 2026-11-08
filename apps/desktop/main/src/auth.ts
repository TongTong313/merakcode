import type { Session } from "electron"
import { existsSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { Endpoint } from "./backend"

/**
 * The main process adds the token to window requests sent to the local backend. Page scripts never see the token, and
 * requests from third-party pages opened in the browser panel (subframes) do not get it.
 */
export namespace Auth {
  export type Request = {
    url: string
    resourceType: string
    initiatorOrigin?: string
    /** Whether the requesting frame is a subframe */
    subframe: boolean
  }

  /** Only requests to the local backend from the app's own main frame get the token; ws:// counts as http:// */
  export function applies(request: Request, origin: string) {
    if (request.subframe || request.resourceType === "subFrame") return false
    if (request.initiatorOrigin !== undefined && request.initiatorOrigin !== origin) return false
    try {
      const target = new URL(request.url)
      const protocol = target.protocol === "ws:" ? "http:" : target.protocol === "wss:" ? "https:" : target.protocol
      return `${protocol}//${target.host}` === origin
    } catch {
      return false
    }
  }

  export function asset(root: string, pathname: string): string | undefined {
    try {
      const decoded = decodeURIComponent(pathname)
      if (!decoded.startsWith("/") || decoded.includes("\\") || decoded.includes("\0")) return
      const base = realpathSync(root)
      let candidate = path.resolve(base, "." + decoded)
      const inside = (file: string) => {
        const relative = path.relative(base, file)
        return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      }
      if (!inside(candidate)) return
      if (!existsSync(candidate) || !statSync(candidate).isFile()) {
        if (path.extname(candidate) || decoded.startsWith("/assets/")) return
        candidate = path.join(base, "index.html")
      }
      candidate = realpathSync(candidate)
      return inside(candidate) ? candidate : undefined
    } catch {
      return undefined
    }
  }

  export function install(
    session: Session,
    current: () => Endpoint | undefined,
    ui?: { root: string; devURL?: string },
  ) {
    if (ui)
      session.protocol.handle("http", async (request) => {
        const endpoint = current()
        const url = new URL(request.url)
        if (!endpoint || url.origin !== endpoint.origin || url.pathname === "/rpc")
          return session.fetch(request, { bypassCustomProtocolHandlers: true })
        if (
          (request.method !== "GET" && request.method !== "HEAD") ||
          (request.headers.has("origin") && request.headers.get("origin") !== endpoint.origin)
        )
          return new Response(null, { status: 403 })
        if (ui.devURL) {
          const target = new URL(url.pathname + url.search, ui.devURL)
          return session.fetch(target.href, { bypassCustomProtocolHandlers: true })
        }
        const file = asset(ui.root, url.pathname)
        return file ? session.fetch(pathToFileURL(file).href) : new Response(null, { status: 404 })
      })
    session.webRequest.onBeforeSendHeaders((details, callback) => {
      const endpoint = current()
      const subframe = (() => {
        try {
          return Boolean(details.frame?.parent)
        } catch {
          // The frame is already destroyed: when in doubt, treat it as a subframe and add no token
          return true
        }
      })()
      const request = {
        url: details.url,
        resourceType: details.resourceType,
        initiatorOrigin: details.initiatorOrigin,
        subframe,
      }
      if (!endpoint || !applies(request, endpoint.origin)) return callback({})
      callback({ requestHeaders: { ...details.requestHeaders, Authorization: endpoint.headers.authorization! } })
    })
  }
}
