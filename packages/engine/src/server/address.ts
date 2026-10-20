/**
 * Where this engine listens, set by Server.listen. Separate from server.ts so the sandbox can keep commands away
 * from the engine's port without importing the server (which imports the tools that import the sandbox).
 */
export namespace ServerAddress {
  let current: URL | undefined

  export function set(url: URL) {
    current = url
  }

  export function port(): number | undefined {
    const value = Number(current?.port)
    return value > 0 ? value : undefined
  }
}
