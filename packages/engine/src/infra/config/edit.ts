import type z from "zod"
import { randomUUID } from "crypto"
import { mkdir, rm } from "fs/promises"
import path from "path"
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser"
import { ConfigWriteGuard } from "./write-guard"
import { Lock } from "@merakcode/engine/infra/concurrency/lock"
import { Filesystem } from "@merakcode/util/filesystem"

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

  export async function commit(
    input: { filepath: string; schema: z.ZodType; invalidJson: string; conflict: string },
    edit: (text: string) => string,
  ) {
    const { filepath } = input
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
      if (errors.length) throw new globalThis.Error(input.invalidJson)
      const parsed = input.schema.safeParse(data)
      if (!parsed.success) {
        throw new globalThis.Error(parsed.error.issues.map((issue) => issue.message).join("; "))
      }
      const temp = path.join(path.dirname(filepath), `.${path.basename(filepath)}.${randomUUID()}.tmp`)
      try {
        await Filesystem.write(temp, written)
        if (!(await ConfigWriteGuard.replace(temp, filepath, snap))) continue
      } finally {
        await rm(temp, { force: true }).catch(() => undefined)
      }
      ConfigWriteGuard.registerSelfWrite(filepath, written)
      return
    }

    throw new globalThis.Error(input.conflict)
  }
}
