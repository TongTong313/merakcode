/**
 * The actual engine listener address. Permissions use this fact without loading the HTTP server.
 */
export namespace EngineAddress {
  let current: URL | undefined

  export function set(url: URL) {
    current = url
  }

  export function port(): number | undefined {
    const value = Number(current?.port)
    return value > 0 ? value : undefined
  }
}
