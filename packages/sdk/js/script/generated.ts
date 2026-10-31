/** Stable schema order keeps module initialization order out of generated SDK diffs. */
export function canonical(value: unknown, key = ""): unknown {
  // These are user values, not schemas; their array order can be meaningful.
  if (["default", "example", "examples", "const"].includes(key)) return value
  if (Array.isArray(value)) {
    const items = key === "enum" ? [...value] : value.map((item) => canonical(item))
    if (["anyOf", "oneOf", "allOf", "required", "enum"].includes(key))
      return items.sort((a, b) => {
        const left = JSON.stringify(a)
        const right = JSON.stringify(b)
        return left < right ? -1 : left > right ? 1 : 0
      })
    return items
  }
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, item]) => [name, canonical(item, name)]),
    )
  return value
}
