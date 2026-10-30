/** Path boundaries of delegated work, such as "src/auth/**" or "src/pay/index.ts", relative to the project */

/** The directory or file a boundary names, or undefined when it is a pattern this cannot reason about */
function base(boundary: string) {
  const value = boundary
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/(\/\*\*|\/\*)+$/, "")
    .replace(/\/+$/, "")
  if (!value || /[*?[\]{}]/.test(value)) return undefined
  return value
}

/** Whether every boundary names a plain directory or file */
export function clear(boundaries: string[]) {
  return boundaries.length > 0 && boundaries.every((item) => base(item) !== undefined)
}

export function inside(file: string, boundary: string) {
  const root = base(boundary)
  if (!root) return false
  const path = file.replaceAll("\\", "/").replace(/^\.\//, "")
  return path === root || path.startsWith(`${root}/`)
}

/** Whether two sets of boundaries could touch the same file; unclear boundaries always could */
export function overlap(left: string[], right: string[]) {
  if (!clear(left) || !clear(right)) return true
  return left.some((a) => right.some((b) => inside(base(a)!, b) || inside(base(b)!, a)))
}

/** The plain directories and files of clear boundaries */
export function roots(boundaries: string[]) {
  return boundaries.flatMap((item) => base(item) ?? [])
}
