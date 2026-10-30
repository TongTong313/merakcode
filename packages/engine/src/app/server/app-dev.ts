import { appAssetHeaders } from "./app-security"

/**
 * Desktop development (apps/desktop/main/script/dev.ts): MERAKCODE_APP_DEV_URL points at the renderer's Vite dev
 * server, and UI requests are forwarded to it instead of reading built files. The window keeps the backend's origin,
 * so authentication, IPC and navigation rules stay as in a release, while Vite serves modules with hot updates.
 */
export namespace AppDev {
  const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"])

  /** The dev server address; only plain HTTP on a loopback address is accepted */
  export function url(value = process.env.MERAKCODE_APP_DEV_URL): URL | undefined {
    if (!value) return undefined
    const parsed = URL.parse(value)
    if (!parsed || parsed.protocol !== "http:" || !LOOPBACK.has(parsed.hostname)) return undefined
    return parsed
  }

  /** Forwards a UI request (path and query only) and returns the answer with the same headers as built files */
  export async function forward(request: Request, base: URL): Promise<Response> {
    const { pathname, search } = new URL(request.url)
    const headers = new Headers()
    // Vite picks index.html for page routes by Accept, and answers module requests it already sent with 304
    for (const name of ["accept", "if-none-match"]) {
      const value = request.headers.get(name)
      if (value) headers.set(name, value)
    }
    const response = await fetch(new URL(pathname + search, base), {
      method: request.method,
      headers,
      redirect: "manual",
    })
    const forwarded = new Headers(appAssetHeaders(response.headers.get("content-type") ?? "application/octet-stream"))
    for (const name of ["etag", "cache-control", "location"]) {
      const value = response.headers.get(name)
      if (value) forwarded.set(name, value)
    }
    return new Response(response.body, { status: response.status, headers: forwarded })
  }
}
