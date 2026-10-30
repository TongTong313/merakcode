import { isIP } from "node:net"

/**
 * Host patterns for the sandbox proxy: `*`, `example.com`, `*.example.com`, an IP address, `[::1]`, each optionally
 * with `:port`. A wildcard never allows a raw IP address; denying `*` blocks everything.
 */
export namespace Domain {
  const NAME = /^(\*|(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*)$/

  function host(input: string) {
    return input
      .trim()
      .toLowerCase()
      .replace(/^\[(.*)\]$/, "$1")
      .replace(/\.$/, "")
  }

  /** Splits `name:port` and `[v6]:port`; a bare IPv6 address has no port */
  function split(pattern: string): { name: string; port?: number } {
    const value = pattern.trim()
    const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(value)
    if (bracket) return { name: bracket[1]!.toLowerCase(), port: bracket[2] ? Number(bracket[2]) : undefined }
    if (isIP(value) === 6) return { name: value.toLowerCase() }
    const colon = /^(.*):(\d+)$/.exec(value)
    if (colon) return { name: host(colon[1]!), port: Number(colon[2]) }
    return { name: host(value) }
  }

  export function valid(pattern: string) {
    if (pattern.trim().endsWith("*.")) return false
    const { name, port } = split(pattern)
    if (port !== undefined && (port < 1 || port > 65535)) return false
    return !!name && (isIP(name) !== 0 || NAME.test(name))
  }

  export function matches(pattern: string, target: string, port: number, kind: "allow" | "deny" = "allow") {
    const rule = split(pattern)
    if (rule.port !== undefined && rule.port !== port) return false
    const name = host(target)
    if (isIP(name)) return rule.name === name || (kind === "deny" && rule.name === "*")
    if (rule.name === "*") return true
    if (rule.name.startsWith("*.")) return name.endsWith(rule.name.slice(1))
    return rule.name === name
  }

  export function loopback(target: string) {
    const name = host(target)
    if (name === "localhost" || name.endsWith(".localhost")) return true
    const v4 = name.startsWith("::ffff:") ? name.slice(7) : name
    if (isIP(v4) === 4) return v4.startsWith("127.")
    return name === "::1"
  }
}
