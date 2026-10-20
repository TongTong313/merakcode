export function getFilename(path: string | undefined) {
  if (!path) return ""
  const trimmed = path.replace(/[\/\\]+$/, "")
  const parts = trimmed.split(/[\/\\]/)
  return parts[parts.length - 1] ?? ""
}

export function getDirectory(path: string | undefined) {
  if (!path) return ""
  const trimmed = path.replace(/[\/\\]+$/, "")
  const parts = trimmed.split(/[\/\\]/)
  return parts.slice(0, parts.length - 1).join("/") + "/"
}

export function getFilenameTruncated(path: string | undefined, maxLength: number = 20) {
  const filename = getFilename(path)
  if (filename.length <= maxLength) return filename
  const lastDot = filename.lastIndexOf(".")
  const ext = lastDot <= 0 ? "" : filename.slice(lastDot)
  const available = maxLength - ext.length - 1 // -1 for ellipsis
  if (available <= 0) return filename.slice(0, maxLength - 1) + "…"
  return filename.slice(0, available) + "…" + ext
}

export function truncateMiddle(text: string, maxLength: number = 20) {
  if (text.length <= maxLength) return text
  const available = maxLength - 1 // -1 for ellipsis
  const start = Math.ceil(available / 2)
  const end = Math.floor(available / 2)
  return text.slice(0, start) + "…" + text.slice(-end)
}

/**
 * Formats the display path of directory tools (grep / glob / list).
 *
 * Unlike getDirectory, which treats its input as a file path and returns the parent, this treats the input as a
 * directory and keeps the last segment.
 *
 * Rules:
 * - no path: the project root (the tool's actual default search directory), or "." without one
 * - path equal to the project root: "."
 * - path inside the project root: the relative path (e.g. "packages/ui")
 * - path outside the project root, or no root: returned as is, with separators normalized
 *
 * Separators become forward slashes so mixed Windows separators do not break the prefix comparison.
 */
export function formatToolDirectory(path: string | undefined, base: string | undefined): string {
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "")
  const b = base ? norm(base) : ""
  if (!path) return b || "."
  const p = norm(path)
  if (!b) return p
  if (p === b) return "."
  if (p.startsWith(b + "/")) return p.slice(b.length + 1)
  return p
}
