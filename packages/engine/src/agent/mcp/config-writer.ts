import { parse as parseJsonc } from "jsonc-parser"
import { Config } from "@merakcode/engine/agent/settings/index"
import { ConfigEdit } from "../../infra/config/edit"

export namespace McpConfigWriter {
  export type Scope = ConfigEdit.Scope
  export type Entry = NonNullable<Config.Info["mcp"]>[string]
  export type Edit = { name: string; value: Entry | undefined } | { name: string; deferred: boolean }

  export function commit(scope: Scope, edits: Edit[]) {
    return Config.edit(scope, (before) =>
      edits.reduce((text, edit) => {
        if (!("deferred" in edit)) return ConfigEdit.set(text, ["mcp", edit.name], edit.value)
        const entry = parseJsonc(text)?.mcp?.[edit.name]
        if (!entry || !Config.Mcp.safeParse(entry).success) {
          throw new globalThis.Error(`MCP server ${edit.name} no longer has a complete configuration`)
        }
        return ConfigEdit.set(text, ["mcp", edit.name, "deferred"], edit.deferred)
      }, before),
    )
  }
}
