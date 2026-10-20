import { existsSync, readFileSync } from "node:fs"
import { parse, type ParseError } from "jsonc-parser"
import { globalConfigFile } from "./paths"

/**
 * The two settings a client needs before it can start the engine: the UI language and whether to check for
 * updates. This is the only place client code reads the engine's config file; everything else goes through the SDK.
 */
export function peekGlobalConfig(file = globalConfigFile()): { locale?: string; autoupdate?: boolean | "notify" } {
  if (!existsSync(file)) return {}
  const config = parse(readFileSync(file, "utf8")) as { locale?: unknown; autoupdate?: unknown } | undefined
  if (!config || typeof config !== "object") return {}
  const autoupdate = config.autoupdate
  return {
    ...(typeof config.locale === "string" ? { locale: config.locale } : {}),
    ...(typeof autoupdate === "boolean" || autoupdate === "notify" ? { autoupdate } : {}),
  }
}

/** A config file for a bug report: the parsed object, or the raw text when it does not parse */
export function readConfigFile(file: string): unknown {
  if (!existsSync(file)) return
  const text = readFileSync(file, "utf8")
  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true }) as unknown
  return errors.length ? text : value
}

/** Where a config file stops being valid JSONC, for `merak doctor`; undefined when it parses or does not exist */
export function configSyntaxError(file: string): { line: number } | undefined {
  if (!existsSync(file)) return
  const text = readFileSync(file, "utf8")
  const errors: ParseError[] = []
  parse(text, errors, { allowTrailingComma: true })
  if (!errors.length) return
  return { line: text.slice(0, errors[0]!.offset).split("\n").length }
}
