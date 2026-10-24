import { globalConfigFile } from "@merakcode/util/paths"
import { randomUUID } from "crypto"
import { mkdir, rename, rm } from "fs/promises"
import path from "path"
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser"
import { Config } from "./config"
import { ConfigWriteGuard } from "./config-write-guard"
import { Lock } from "../util/lock"
import { Filesystem } from "@merakcode/util/filesystem"
import { Text } from "../util/text"

/**
 * Edits the config file of a scope in place: comments and the other fields stay, the result must still be a valid
 * config, and an edit that races another write to the file is done again on the new text.
 */
export namespace ConfigEdit {
  export type Scope = "project" | "global"

  /** The text with the value at keys set, or removed when value is undefined */
  export function set(text: string, keys: string[], value: unknown) {
    return applyEdits(text, modify(text, keys, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
  }

  export async function commit(scope: Scope, edit: (text: string) => string) {
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
      const written = edit(before)
      if (written === before) return
      const errors: ParseError[] = []
      const data = parseJsonc(written, errors, { allowTrailingComma: true })
      if (errors.length)
        throw new globalThis.Error(
          await Text.pick({ zh: "配置写入生成了无效 JSONC", en: "Writing the config produced invalid JSONC" }),
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
        zh: "并发写入配置失败，请重试",
        en: "Failed to write the config due to concurrent writes; please retry",
      }),
    )
  }
}
