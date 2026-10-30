import type z from "zod"
import type { Text } from "@merakcode/util/text"

/**
 * A config degradation warning. The file on disk is left as is; the user is asked to fix it.
 * A string reason is shown verbatim (e.g. the zod issue message). Reasons written by the engine come in both
 * languages, because the locale is not known yet while loading; Config.warnings() picks the UI language.
 */
export type ConfigWarning = {
  path: string
  item: string
  reason: string | Text.Pair
}

/** Validates one source, recovering valid entries without rewriting the source file. */
export function validateConfig<T>(schema: z.ZodType<T>, data: unknown, filepath: string) {
  const parsed = schema.safeParse(data)
  if (parsed.success) return { data: parsed.data, warnings: [] as ConfigWarning[], valid: true }
  const recovered = recoverConfig(schema, data, filepath)
  return { data: recovered.data as T, warnings: recovered.warnings, valid: false }
}

const EMPTY_FALLBACK: Text.Pair = {
  zh: "配置无法通过校验，已临时按空配置加载；请修改后重载",
  en: "The config failed validation and was loaded as empty for now. Fix it and reload.",
}

type ZodIssue = z.core.$ZodIssue

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function cloneData(data: unknown): unknown {
  return structuredClone(data)
}

function itemPath(path: PropertyKey[]): string {
  if (path.length === 0) return "(root)"
  return path.map(String).join(".")
}

function getParent(
  data: unknown,
  path: PropertyKey[],
): { parent: Record<string, unknown> | unknown[]; key: PropertyKey } | undefined {
  if (path.length === 0) return
  let current: unknown = data
  for (let i = 0; i < path.length - 1; i++) {
    if (!isRecord(current) && !Array.isArray(current)) return
    current = (current as any)[path[i]]
  }
  if (!isRecord(current) && !Array.isArray(current)) return
  return { parent: current as any, key: path[path.length - 1] }
}

function deletePath(data: unknown, path: PropertyKey[]): boolean {
  const target = getParent(data, path)
  if (!target) return false
  const { parent, key } = target
  if (Array.isArray(parent)) {
    const index = Number(key)
    if (!Number.isInteger(index) || index < 0 || index >= parent.length) return false
    parent.splice(index, 1)
    return true
  }
  if (!(String(key) in parent)) return false
  delete parent[String(key)]
  return true
}

function deleteKeys(data: unknown, path: PropertyKey[], keys: string[]): boolean {
  let current: unknown = data
  for (const part of path) {
    if (!isRecord(current) && !Array.isArray(current)) return false
    current = (current as any)[part]
  }
  if (!isRecord(current)) return false
  let changed = false
  for (const key of keys) {
    if (key in current) {
      delete current[key]
      changed = true
    }
  }
  return changed
}

/**
 * The keys to remove when a discriminated union branch fails only on unknown keys: removing them makes the item
 * valid, so the whole item should not be dropped.
 *
 * `Config.Mcp` is a `discriminatedUnion` whose branches are both `.strict()`. One extra field (written by an older
 * version, or a typo) makes zod report an item-level `invalid_union` ("Invalid input"), and `deletePath` would drop
 * the whole MCP entry: the server silently disappears, and the log only says `config degraded, skipped invalid item`.
 *
 * If every issue of a branch is `unrecognized_keys`, remove those keys, using the branch with the fewest keys (the
 * local branch counts the remote `type`/`url` as unknown, for example). Anything else still skips the whole item.
 */
function unionExtraKeys(issue: ZodIssue): string[] | undefined {
  if (issue.code !== "invalid_union") return
  const branches = (issue as { errors?: ZodIssue[][] }).errors ?? []
  let best: string[] | undefined
  for (const branch of branches) {
    if (branch.length === 0) continue
    if (!branch.every((item) => item.code === "unrecognized_keys" && item.path.length === 0)) continue
    const keys = branch.flatMap((item) => (item as { keys: string[] }).keys)
    if (!best || keys.length < best.length) best = keys
  }
  return best
}

function applyIssue(data: unknown, issue: ZodIssue): boolean {
  if (issue.code === "unrecognized_keys") {
    return deleteKeys(data, issue.path, issue.keys)
  }
  const extra = unionExtraKeys(issue)
  if (extra?.length) return deleteKeys(data, issue.path, extra)
  if (issue.path.length === 0) {
    if (!isRecord(data)) return false
    for (const key of Object.keys(data)) delete data[key]
    return true
  }
  return deletePath(data, issue.path)
}

function reasonOf(issue: ZodIssue): string {
  return issue.message || issue.code
}

/**
 * Skips bad fields in memory, following the Zod issue paths, until the schema passes or only an empty object is left.
 * Nothing is written to disk; every skip is recorded in warnings so the UI can ask the user to fix the file.
 */
export function recoverConfig(
  schema: z.ZodType,
  data: unknown,
  filePath: string,
): { data: unknown; warnings: ConfigWarning[] } {
  const warnings: ConfigWarning[] = []
  let current = cloneData(data)

  for (let attempt = 0; attempt < 64; attempt++) {
    const parsed = schema.safeParse(current)
    if (parsed.success) return { data: parsed.data, warnings }

    let changed = false
    for (const issue of parsed.error.issues) {
      warnings.push({
        path: filePath,
        item: itemPath(issue.path),
        reason: reasonOf(issue),
      })
      if (applyIssue(current, issue)) changed = true
    }

    if (!changed) {
      warnings.push({
        path: filePath,
        item: "(root)",
        reason: EMPTY_FALLBACK,
      })
      return { data: {}, warnings }
    }
  }

  warnings.push({
    path: filePath,
    item: "(root)",
    reason: EMPTY_FALLBACK,
  })
  return { data: {}, warnings }
}
