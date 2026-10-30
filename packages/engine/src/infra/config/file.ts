import type z from "zod"
import fs from "node:fs/promises"
import path from "node:path"
import {
  applyEdits,
  modify,
  parse as parseJsonc,
  printParseErrorCode,
  type ParseError as JsoncParseError,
} from "jsonc-parser"
import { Lock } from "../concurrency/lock"
import { Atomic } from "../file/atomic"
import { Filesystem } from "@merakcode/util/filesystem"
import { ConfigWriteGuard } from "./write-guard"
import { JsonError, InvalidError } from "./error"

export namespace ConfigFile {
  function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
  }
  export function patch(input: string, changes: unknown, path: string[] = []): string {
    if (!isRecord(changes)) {
      const edits = modify(input, path, changes, {
        formattingOptions: {
          insertSpaces: true,
          tabSize: 2,
        },
      })
      return applyEdits(input, edits)
    }

    return Object.entries(changes).reduce((result, [key, value]) => {
      if (value === undefined) return result
      return patch(result, value, [...path, key])
    }, input)
  }

  export function parse<T>(schema: z.ZodType<T>, text: string, filepath: string): T {
    const errors: JsoncParseError[] = []
    const data = parseJsonc(text, errors, { allowTrailingComma: true })
    if (errors.length) {
      const lines = text.split("\n")
      const errorDetails = errors
        .map((e) => {
          const beforeOffset = text.substring(0, e.offset).split("\n")
          const line = beforeOffset.length
          const column = beforeOffset[beforeOffset.length - 1].length + 1
          const problemLine = lines[line - 1]

          const error = `${printParseErrorCode(e.error)} at line ${line}, column ${column}`
          if (!problemLine) return error

          return `${error}\n   Line ${line}: ${problemLine}\n${"".padStart(column + 9)}^`
        })
        .join("\n")

      throw new JsonError({
        path: filepath,
        message: `\n--- JSONC Input ---\n${text}\n--- Errors ---\n${errorDetails}\n--- End ---`,
      })
    }

    const parsed = schema.safeParse(data)
    if (parsed.success) return parsed.data

    throw new InvalidError({
      path: filepath,
      issues: parsed.error.issues,
    })
  }

  export async function read(filepath: string) {
    return Filesystem.readText(filepath).catch((err) => {
      if (err.code === "ENOENT") return "{}"
      throw new JsonError({ path: filepath }, { cause: err })
    })
  }

  export async function write<T>(
    filepath: string,
    prepare: (before: string) => Promise<{ merged: T; written: string }>,
    conflict: () => Promise<Error>,
  ) {
    await fs.mkdir(path.dirname(filepath), { recursive: true }).catch(() => undefined)
    // One lock per file, so writes to the global config and to each project never block each other.
    const lockKey = `config:${ConfigWriteGuard.normalizePath(filepath)}`

    for (let attempt = 0; attempt < ConfigWriteGuard.maxRetries(); attempt++) {
      using _ = await Lock.write(lockKey)
      const snap = await ConfigWriteGuard.snapshot(filepath)
      const before = await read(filepath)
      const { merged, written } = await prepare(before)
      if (await ConfigWriteGuard.changed(snap, filepath)) continue
      await Atomic.write(filepath, written)
      ConfigWriteGuard.registerSelfWrite(filepath, written)
      return merged
    }

    throw await conflict()
  }

  export async function editExisting(filepath: string, transform: (text: string) => string, create = false) {
    if (create) await fs.mkdir(path.dirname(filepath), { recursive: true }).catch(() => undefined)
    const before = await Filesystem.readText(filepath).catch((err) => {
      if (err.code === "ENOENT") return create ? "{}" : undefined
      throw new JsonError({ path: filepath }, { cause: err })
    })
    if (before === undefined) return false

    const written = transform(before)
    if (written === before) return false

    const lockKey = `config:${ConfigWriteGuard.normalizePath(filepath)}`
    for (let attempt = 0; attempt < ConfigWriteGuard.maxRetries(); attempt++) {
      using _ = await Lock.write(lockKey)
      const snap = await ConfigWriteGuard.snapshot(filepath)
      const current = await Filesystem.readText(filepath).catch((err) => {
        if (err.code === "ENOENT") return create ? "{}" : undefined
        throw new JsonError({ path: filepath }, { cause: err })
      })
      if (current === undefined) return false
      const nextWritten = transform(current)
      if (nextWritten === current) return false
      if (await ConfigWriteGuard.changed(snap, filepath)) continue
      await Filesystem.write(filepath, nextWritten)
      ConfigWriteGuard.registerSelfWrite(filepath, nextWritten)
      break
    }

    return true
  }
  export async function addSchema(filepath: string, original: string, schema: string) {
    using _ = await Lock.write(`config:${ConfigWriteGuard.normalizePath(filepath)}`)
    // Substitutions can await file reads. A patch or deletion since this load must not be overwritten or recreated.
    if ((await Filesystem.readText(filepath)) !== original) return
    const updated = original.replace(/^\s*\{/, () => `{\n  "$schema": "${schema}",`)
    await Atomic.write(filepath, updated)
    ConfigWriteGuard.registerSelfWrite(filepath, updated)
  }

  export function patchTopLevelKeys(
    text: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): string {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    return [...keys].reduce((acc, key) => {
      const prev = before[key]
      const next = after[key]
      if (JSON.stringify(prev) === JSON.stringify(next)) return acc
      const edits = modify(acc, [key], next === undefined ? undefined : next, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      })
      return applyEdits(acc, edits)
    }, text)
  }

  export function deleteFields(text: string, paths: string[][]): string {
    return paths.reduce((acc, path) => {
      const edits = modify(acc, path, undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } })
      return applyEdits(acc, edits)
    }, text)
  }
  export function parseInput<T>(schema: z.ZodType<T>, text: string, filepath: string): unknown {
    const errors: JsoncParseError[] = []
    const data = parseJsonc(text, errors, { allowTrailingComma: true })
    if (!errors.length) return data ?? {}

    // Reuse parseConfig for a detailed JSONC parse error with line and column context.
    parse(schema, text, filepath)
    return {}
  }

  export function parseObject(text: string): Record<string, unknown> {
    const errors: JsoncParseError[] = []
    const data = parseJsonc(text, errors)
    if (errors.length || !data || typeof data !== "object" || Array.isArray(data)) return {}
    return data as Record<string, unknown>
  }
}
