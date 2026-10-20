import { z } from "zod"
import { Config } from "../src/config/config"
import { Filesystem } from "@merakcode/util/filesystem"

/**
 * Generates the JSON Schema of the config file (Config.SCHEMA points to the copy in the repository).
 * Usage: schema.ts <output file> [--check]; --check only compares and exits 1 when the file is out of date.
 */
const file = process.argv[2]!
const check = process.argv.includes("--check")

const result = z.toJSONSchema(Config.Info, {
  io: "input", // Generate input shape (treats optional().default() as not required)
  // Repeated sub-schemas (such as the agent config under each agent name) become $defs references, not inlined
  reused: "ref",
}) as Record<string, unknown>

// zod also moves single-use sub-schemas into $defs (e.g. an enum wrapped in .describe()). Inline those that are
// referenced once; keep only real repeats in $defs, renumbered in order of appearance.
function inlineSingleUse(doc: Record<string, unknown>) {
  const defs = (doc.$defs ?? {}) as Record<string, Record<string, unknown>>
  const name = (ref: unknown) => (typeof ref === "string" && ref.startsWith("#/$defs/") ? ref.slice(8) : undefined)
  const count = new Map<string, number>()
  const tally = (node: unknown): void => {
    if (!node || typeof node !== "object") return
    const target = name((node as { $ref?: unknown }).$ref)
    if (target) count.set(target, (count.get(target) ?? 0) + 1)
    Object.values(node).forEach(tally)
  }
  tally(doc)
  const expand = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(expand)
    if (!node || typeof node !== "object") return node
    const { $ref, ...rest } = node as Record<string, unknown>
    const target = name($ref)
    const body = Object.fromEntries(Object.entries(rest).map(([key, value]) => [key, expand(value)]))
    if (!target || count.get(target) !== 1 || !defs[target]) return $ref === undefined ? body : { ...body, $ref }
    return { ...body, ...(expand(defs[target]) as Record<string, unknown>), ...body }
  }
  const { $defs: _, ...top } = doc
  const expanded = expand(top) as Record<string, unknown>
  const kept = Object.keys(defs).filter((key) => (count.get(key) ?? 0) > 1)
  if (!kept.length) return expanded
  const order: string[] = []
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return
    const target = name((node as { $ref?: unknown }).$ref)
    if (target && kept.includes(target) && !order.includes(target)) {
      order.push(target)
      visit(expand(defs[target]))
    }
    Object.values(node).forEach(visit)
  }
  visit(expanded)
  const rename = new Map(order.map((key, index) => [key, `__schema${index}`]))
  const relink = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(relink)
    if (!node || typeof node !== "object") return node
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [
        key,
        key === "$ref" && name(value) ? `#/$defs/${rename.get(name(value)!)}` : relink(value),
      ]),
    )
  }
  return {
    ...(relink(expanded) as Record<string, unknown>),
    $defs: Object.fromEntries(order.map((key) => [rename.get(key)!, relink(expand(defs[key]))])),
  }
}

/**
 * Objects reject unknown fields; string fields with a default get it added to examples and the description, so
 * editors show the default without a trip to the docs. Runs after inlining, because zod may put the default and the
 * type on different levels
 * (see https://json-schema.org/draft/2020-12/draft-bhutton-json-schema-validation-00#rfc.section.9.5).
 */
function annotate(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(annotate)
  if (!node || typeof node !== "object") return node
  const schema = Object.fromEntries(Object.entries(node).map(([key, value]) => [key, annotate(value)]))
  if (schema.type === "object" && schema.additionalProperties === undefined) schema.additionalProperties = false
  if (schema.type === "string" && schema.default) {
    schema.examples ??= [schema.default]
    schema.description = [schema.description || "", `default: \`${schema.default}\``].filter(Boolean).join("\n\n")
  }
  return schema
}

const output = {
  ...(annotate(inlineSingleUse(result)) as Record<string, unknown>),
  // The config file is JSONC; tell editor JSON language services to allow comments and trailing commas
  allowComments: true,
  allowTrailingCommas: true,
}

const text = JSON.stringify(output, null, 2) + "\n"
if (check) {
  const current = await Filesystem.readText(file).catch(() => "")
  if (current !== text) {
    console.error(`${file} is out of date, run: pnpm generate:schema`)
    process.exit(1)
  }
} else await Filesystem.write(file, text)
