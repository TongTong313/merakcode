/**
 * Environment for processes the engine starts (commands, MCP servers, LSP, formatters, terminals).
 * The engine's password and inline config never reach them: a child that knows the password could call the
 * engine's own API and approve its own requests.
 */
export namespace ChildEnv {
  export const BLOCKED = [
    "MERAKCODE_SERVER_PASSWORD",
    "MERAKCODE_SERVER_USERNAME",
    "MERAKCODE_SERVER_PARENT_PID",
    "MERAKCODE_CONFIG_CONTENT",
  ]

  export function build(input: {
    base?: NodeJS.ProcessEnv
    extra?: Record<string, string | undefined>
  }): Record<string, string> {
    const blocked = new Set(BLOCKED.map((key) => key.toUpperCase()))
    return Object.fromEntries(
      Object.entries({ ...(input.base ?? process.env), ...input.extra }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined && !blocked.has(entry[0].toUpperCase()),
      ),
    )
  }
}
