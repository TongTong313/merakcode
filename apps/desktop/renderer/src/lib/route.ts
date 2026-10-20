/**
 * In-app routes: `/:dir/session/:id?`, where dir is the project directory in base64url (URL-safe characters, no
 * padding; must match route.ts in the main process)
 */
export function encodeDir(directory: string) {
  const binary = Array.from(new TextEncoder().encode(directory), (byte) => String.fromCharCode(byte)).join("")
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

export function decodeDir(segment: string) {
  try {
    const b64 = segment.replace(/-/g, "+").replace(/_/g, "/")
    const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
  } catch {
    return
  }
}

export const sessionPath = (directory: string, sessionID?: string) =>
  `/${encodeDir(directory)}/session${sessionID ? `/${encodeURIComponent(sessionID)}` : ""}`

/**
 * Treats spellings of one directory (case, slash direction, trailing slash) as equal; case-insensitive on Windows and
 * macOS
 */
export function sameDir(a: string, b: string, os = navigator.platform.toLowerCase()) {
  const normalize = (value: string) => {
    const slashes = value.replace(/\\/g, "/").replace(/\/+$/, "").normalize("NFC")
    return os.startsWith("win") || os.includes("mac") ? slashes.toLowerCase() : slashes
  }
  return normalize(a) === normalize(b)
}

/** Directory name, as shown in the sidebar and titles */
export const baseName = (directory: string) =>
  directory
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || directory

/** Path relative to root with forward slashes; returned unchanged when outside root */
export function relative(root: string, file: string) {
  const a = root.replace(/\\/g, "/").replace(/\/+$/, "")
  const b = file.replace(/\\/g, "/")
  return sameDir(b.slice(0, a.length), a) && b[a.length] === "/" ? b.slice(a.length + 1) : b
}
