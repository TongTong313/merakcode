export function lazy<T>(fn: () => T) {
  let value: T | undefined
  let loaded = false

  const result = (): T => {
    if (loaded) return value as T
    loaded = true
    value = fn()
    return value as T
  }

  // Clears the cache so the next call evaluates again (engine config, models, oidc and others rely on this)
  result.reset = () => {
    loaded = false
    value = undefined
  }

  return result
}
