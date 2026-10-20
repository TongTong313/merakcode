import type { Session } from "electron"
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

  export function install(session: Session, current: () => Endpoint | undefined) {
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
