/**
 * Content security policy of the desktop UI. The UI embeds no iframes (the browser panel is a native view in the main
 * process) and only connects to the local backend (HTTP and the terminal WebSocket). Images in model replies may come
 * from external URLs.
 */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: http: https:",
  "font-src 'self' data:",
  "media-src 'self' data: blob: http: https:",
  "connect-src 'self' ws: wss:",
  "frame-src 'none'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ")

const STATIC_ASSET_EXT = /\.(wasm|js|mjs|cjs|css|map|woff2?|ttf|otf|png|jpe?g|gif|svg|ico|webp|json)$/i

function normalizeAssetPath(path: string): string {
  const pathname = path.split("?")[0].split("#")[0]
  return pathname.startsWith("/") ? pathname : `/${pathname}`
}

/**
 * Frontend build output (including the Ghostty WASM). A 404 on these paths must not fall back to index.html, or
 * WebAssembly.compile would treat `<!doctype html>` as a module.
 */
export function isFrontendStaticAssetPath(path: string): boolean {
  const pathname = normalizeAssetPath(path)
  return pathname.startsWith("/assets/") || STATIC_ASSET_EXT.test(pathname)
}

/** Under nosniff, WASM must be served as application/wasm, not the generic octet-stream */
export function resolveAssetContentType(path: string, fileType: string): string {
  if (normalizeAssetPath(path).toLowerCase().endsWith(".wasm")) return "application/wasm"
  return fileType || "application/octet-stream"
}

export function appAssetHeaders(type: string): Record<string, string> {
  const headers = {
    "content-type": type,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  }
  if (!type.toLowerCase().startsWith("text/html")) return headers
  return { ...headers, "content-security-policy": APP_CSP }
}
