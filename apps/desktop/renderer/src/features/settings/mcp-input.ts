import type { ConfigMCPServer } from "@merakcode/sdk"

/** Splits a command on whitespace, keeping whitespace inside double quotes. */
export const words = (text: string) => [...text.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? "")

/** One KEY=VALUE per line (headers may also be written as Name: value). */
export const pairs = (text: string) =>
  Object.fromEntries(
    text.split("\n").flatMap((line) => {
      const at = line.search(/[=:]/)
      const key = line.slice(0, at).trim()
      return at > 0 && key ? [[key, line.slice(at + 1).trim()]] : []
    }),
  )

/** The server the add form describes: an address is a remote server, anything else is a command to run. */
export function mcpDefinition(target: string, extra: string): ConfigMCPServer {
  const value = target.trim()
  const lines = pairs(extra)
  const has = Object.keys(lines).length > 0
  if (/^https?:\/\//i.test(value)) return { type: "remote", url: value, ...(has ? { headers: lines } : {}) }
  const [command = "", ...args] = words(value)
  return { type: "local", command, ...(args.length ? { args } : {}), ...(has ? { env: lines } : {}) }
}
