/**
 * Writes docs/sdk/reference.md: every engine endpoint as a client method, with its parameters and return type.
 * Endpoints, types and descriptions come from packages/sdk/openapi.json; parameter names come from the generated
 * client, because a body passed whole is nested under a key that only the generator decides.
 *
 * Usage (repo root): pnpm generate:sdk-reference, or pnpm check:sdk-reference to fail when the file is out of date.
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { format, resolveConfig } from "prettier"
import { Filesystem } from "@merakcode/util/filesystem"

type Schema = {
  $ref?: string
  type?: string | string[]
  items?: Schema
  anyOf?: Schema[]
  oneOf?: Schema[]
  enum?: unknown[]
  const?: unknown
  properties?: Record<string, Schema>
  additionalProperties?: Schema | boolean
  required?: string[]
  description?: string
}

type Operation = {
  operationId: string
  summary?: string
  description?: string
  parameters?: { in: string; name: string; required?: boolean; schema?: Schema; description?: string }[]
  requestBody?: { required?: boolean; content?: Record<string, { schema?: Schema }> }
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: Schema }> }>
}

export type Spec = {
  paths: Record<string, Record<string, Operation>>
  components?: { schemas?: Record<string, Schema> }
}

type Param = { name: string; type: string; required: boolean; description: string }

export type Entry = {
  id: string
  /** Property path on the client, e.g. ["session", "promptAsync"] */
  call: string[]
  http: string
  route: string
  summary: string
  description: string
  params: Param[]
  returns: string
}

const HTTP = ["get", "post", "put", "patch", "delete"]
const camel = (text: string) => text.replace(/[_-](\w)/g, (_, char: string) => char.toUpperCase())
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const name = (ref: string) => ref.split("/").at(-1)!

function resolve(spec: Spec, schema: Schema | undefined): Schema | undefined {
  if (!schema?.$ref) return schema
  return spec.components?.schemas?.[name(schema.$ref)]
}

/** Objects nested deeper than this show as `object`, so a return type stays readable on one line */
const DEPTH = 2

function typeOf(schema: Schema | undefined, depth = 0): string {
  if (!schema) return "unknown"
  if (schema.$ref) return name(schema.$ref)
  const union = schema.anyOf ?? schema.oneOf
  if (union) return union.map((item) => typeOf(item, depth)).join(" | ")
  if (schema.const !== undefined) return JSON.stringify(schema.const)
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ")
  if (Array.isArray(schema.type)) return schema.type.map((type) => typeOf({ ...schema, type }, depth)).join(" | ")
  if (schema.type === "array") {
    const item = typeOf(schema.items, depth)
    return item.includes(" ") ? `(${item})[]` : `${item}[]`
  }
  if (schema.type === "integer") return "number"
  if (schema.type === "object" && !schema.properties && typeof schema.additionalProperties === "object")
    return `Record<string, ${typeOf(schema.additionalProperties, depth + 1)}>`
  if (schema.properties) {
    if (depth >= DEPTH) return "object"
    const fields = Object.entries(schema.properties).map(
      ([key, value]) => `${key}${schema.required?.includes(key) ? "" : "?"}: ${typeOf(value, depth + 1)}`,
    )
    return fields.length ? `{ ${fields.join("; ")} }` : "{}"
  }
  return schema.type ?? "unknown"
}

const json = (content: Record<string, { schema?: Schema }> | undefined) => content?.["application/json"]?.schema

/** Generated parameter keys of the method that sends `http` to `route`, plus the method's name */
function generatedArgs(code: string, http: string, route: string) {
  const at = code.search(new RegExp(`\\.${http}<[^>]*>\\(\\s*\\{\\s*url: "${escape(route)}"`))
  if (at < 0) return undefined
  const start = code.lastIndexOf("public ", at)
  const method = /^public (\w+)/.exec(code.slice(start))?.[1]
  const body = code.slice(start, at)
  const args = [...body.matchAll(/\{\s*(?:in:\s*"(\w+)",\s*)?key:\s*"(\w+)"(?:,\s*map:\s*"(\w+)")?\s*\}/g)].map(
    (match) => ({ in: match[1] ?? match[3] ?? "", key: match[2]! }),
  )
  return { method, args }
}

export function operations(spec: Spec, code: string): Entry[] {
  return Object.entries(spec.paths).flatMap(([route, item]) =>
    Object.entries(item)
      .filter(([http]) => HTTP.includes(http))
      .map(([http, op]) => {
        const parts = op.operationId.split(".")
        const call = [...parts.slice(0, -1), camel(parts.at(-1)!)]
        const found = generatedArgs(code, http, route)
        if (!found || found.method !== call.at(-1))
          throw new Error(`The generated client has no method ${call.join(".")} for ${op.operationId}`)
        const body = json(op.requestBody?.content)
        const fields = resolve(spec, body)
        const params = found.args
          .filter((arg) => arg.key !== "directory")
          .map((arg): Param => {
            if (arg.in === "body" && fields?.properties?.[arg.key] === undefined && body)
              return { name: arg.key, type: typeOf(body), required: !!op.requestBody?.required, description: "" }
            if (arg.in === "body") {
              const field = fields!.properties![arg.key]!
              return {
                name: arg.key,
                type: typeOf(field),
                required: !!fields?.required?.includes(arg.key),
                description: field.description ?? "",
              }
            }
            const param = op.parameters?.find((item) => item.name === arg.key)
            return {
              name: arg.key,
              type: typeOf(param?.schema),
              required: !!param?.required,
              description: param?.description ?? "",
            }
          })
        const success = Object.entries(op.responses ?? {}).find(([status]) => status.startsWith("2"))?.[1]
        const result = json(success?.content)
        const stream = success?.content?.["text/event-stream"]?.schema
        return {
          id: op.operationId,
          call,
          http: http.toUpperCase(),
          route,
          summary: op.summary ?? "",
          description: op.description ?? "",
          params,
          returns: result ? typeOf(result) : stream ? `stream of ${typeOf(stream)}` : "",
        }
      }),
  )
}

const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ")

const INTRO = `# SDK 接口参考 · SDK API reference

> 这个文件由 \`pnpm generate:sdk-reference\` 根据 \`packages/sdk/openapi.json\` 生成，不要手改。用法见 [SDK 手册](README.md)。
> Generated by \`pnpm generate:sdk-reference\` from \`packages/sdk/openapi.json\`. Do not edit by hand. See the [SDK guide](README.en.md) for how to use it.

Every method takes one object with the parameters below, plus an optional second \`options\` argument
(\`signal\`, \`headers\`, \`throwOnError\`...). It resolves to \`{ data, error, response }\`; \`data\` has the type shown under
"Returns". Event streams resolve to \`{ stream }\` instead, an async iterable of events. Types are exported from
\`@merakcode/sdk/client\`. Every method also accepts \`directory\`, which the client
already fills in from \`createMerakCodeClient({ directory })\`, so it is left out of the tables.
`

export function render(list: Entry[]): string {
  const groups = Map.groupBy(list, (entry) => entry.call.slice(0, -1).join("."))
  const toc = [...groups.keys()].map((group) => `- [${group}](#${group.replaceAll(".", "").toLowerCase()})`)
  const sections = [...groups].flatMap(([group, entries]) => [
    `## ${group}`,
    "",
    ...entries.flatMap((entry) => [
      `### client.${entry.call.join(".")}`,
      "",
      `\`${entry.http} ${entry.route}\` · operationId \`${entry.id}\``,
      "",
      ...[entry.summary, entry.description]
        .filter((text, index, all) => text && all.indexOf(text) === index)
        .map((text) => (text.endsWith(".") ? text : `${text}.`))
        .flatMap((text) => [text, ""]),
      ...(entry.params.length
        ? [
            "| Parameter | Type | Required | Description |",
            "| --- | --- | --- | --- |",
            ...entry.params.map(
              (param) =>
                `| \`${param.name}\` | \`${cell(param.type)}\` | ${param.required ? "yes" : "no"} | ${cell(param.description)} |`,
            ),
            "",
          ]
        : ["No parameters.", ""]),
      `Returns: ${entry.returns ? `\`${cell(entry.returns)}\`` : "nothing"}`,
      "",
    ]),
  ])
  return [INTRO, ...toc, "", ...sections].join("\n")
}

async function main() {
  const root = path.resolve(import.meta.dirname, "..")
  const file = path.resolve(root, "../../../docs/sdk/reference.md")
  const spec = JSON.parse(readFileSync(path.join(root, "../openapi.json"), "utf8")) as Spec
  const code = readFileSync(path.join(root, "src/client/gen/sdk.gen.ts"), "utf8")
  const config = await resolveConfig(file)
  const text = await format(render(operations(spec, code)), { ...config, filepath: file })
  if (process.argv.includes("--check")) {
    const current = await Filesystem.readText(file).catch(() => "")
    if (current.replaceAll("\r\n", "\n") === text) return
    console.error("docs/sdk/reference.md is out of date, run: pnpm generate:sdk-reference")
    process.exitCode = 1
    return
  }
  await Filesystem.write(file, text)
}

if (import.meta.main) await main()
