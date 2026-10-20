import { globalConfigFile } from "@merakcode/util/paths"
import { randomUUID } from "crypto"
import { mkdir, rename, rm } from "fs/promises"
import path from "path"
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser"
import { Config } from "../config/config"
import { ConfigWriteGuard } from "../config/config-write-guard"
import { Lock } from "../util/lock"
import { Filesystem } from "@merakcode/util/filesystem"
import { Text } from "../util/text"

export namespace McpConfigWriter {
  export type Scope = "project" | "global"
  export type Entry = NonNullable<Config.Info["mcp"]>[string]
  export type Edit = { name: string; value: Entry | undefined } | { name: string; deferred: boolean }

  export async function commit(scope: Scope, edits: Edit[]) {
    const filepath = scope === "global" ? globalConfigFile() : Config.projectMerakCodeFile()
    await mkdir(path.dirname(filepath), { recursive: true })
    const key = `config:${ConfigWriteGuard.normalizePath(filepath)}`

    for (let attempt = 0; attempt < ConfigWriteGuard.maxRetries(); attempt++) {
      using _ = await Lock.write(key)
      const snap = await ConfigWriteGuard.snapshot(filepath)
      const before = await Filesystem.readText(filepath).catch((error) => {
        if (error.code === "ENOENT") return "{}"
        throw error
      })
      const written = edits.reduce((text, edit) => {
        if ("deferred" in edit) {
          const entry = parseJsonc(text)?.mcp?.[edit.name]
          if (!entry || !Config.Mcp.safeParse(entry).success) {
            throw new globalThis.Error(`MCP server ${edit.name} no longer has a complete configuration`)
          }
        }
        return applyEdits(
          text,
          modify(
            text,
            "deferred" in edit ? ["mcp", edit.name, "deferred"] : ["mcp", edit.name],
            "deferred" in edit ? edit.deferred : edit.value,
            {
              formattingOptions: { insertSpaces: true, tabSize: 2 },
            },
          ),
        )
      }, before)
      if (written === before) return
      const errors: ParseError[] = []
      const data = parseJsonc(written, errors, { allowTrailingComma: true })
      if (errors.length)
        throw new globalThis.Error(
          await Text.pick({
            zh: "MCP 配置写入生成了无效 JSONC",
            en: "Writing the MCP config produced invalid JSONC",
          }),
        )
      const parsed = Config.Info.safeParse(data)
      if (!parsed.success) {
        throw new globalThis.Error(parsed.error.issues.map((issue) => issue.message).join("; "))
      }
      if (await ConfigWriteGuard.changed(snap, filepath)) continue

      const temp = path.join(path.dirname(filepath), `.${path.basename(filepath)}.${randomUUID()}.tmp`)
      try {
        await Filesystem.write(temp, written)
        await rename(temp, filepath)
      } finally {
        await rm(temp, { force: true }).catch(() => undefined)
      }
      ConfigWriteGuard.registerSelfWrite(filepath, written)
      Config.invalidateScope(scope)
      return
    }

    throw new globalThis.Error(
      await Text.pick({
        zh: "并发写入 MCP 配置失败，请重试",
        en: "Failed to write the MCP config due to concurrent writes; please retry",
      }),
    )
  }
}
