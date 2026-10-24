import { readFileSync } from "node:fs"
import path from "node:path"
import { expect, test } from "vitest"
import { exported, missing, snippets } from "../script/docs"

const root = path.resolve(import.meta.dirname, "..")
const read = (file: string) => readFileSync(path.resolve(root, file), "utf8")

test("exported names come from declaration lines only, without duplicates", () => {
  const api = [
    "# @merakcode/sdk",
    "## @merakcode/sdk",
    "function createMerakCode(options?: MerakCodeOptions): Promise<MerakCode>",
    "type Logger = (entry: LogEntry) => void",
    "class MerakCodeError extends Error { readonly code: string }",
    "interface RequestDeadlineTimer { set(run: () => void, delay: number): unknown }",
    "+ 919 exports generated from openapi.json",
    "## @merakcode/sdk/errors",
    "class MerakCodeError extends Error { readonly code: string }",
  ].join("\n")
  expect(exported(api)).toEqual(["createMerakCode", "Logger", "MerakCodeError", "RequestDeadlineTimer"])
})

test("a name counts as covered only as a whole word", () => {
  expect(missing(["tool", "search", "Hooks"], "use `tool()` and `research` here")).toEqual(["search", "Hooks"])
})

test("only ts code blocks are compiled", () => {
  const markdown = ["text", "```ts", "const a = 1", "```", "```sh", "npm i", "```", "```ts", "const b = 2", "```"].join(
    "\n",
  )
  expect(snippets(markdown)).toEqual(["const a = 1\n", "const b = 2\n"])
})

test("a code block that imports the single-file adapter library is compiled against the SDK's adapter entry", () => {
  const markdown = ["```ts", 'import { adapter, type Host } from "./merakcode-adapter.mjs"', "```"].join("\n")
  expect(snippets(markdown)).toEqual(['import { adapter, type Host } from "@merakcode/sdk/adapter"\n'])
})

test("the guide in both languages mentions every hand-written export", () => {
  const names = exported(read("api.md"))
  expect(names.length).toBeGreaterThan(50)
  expect(missing(names, read("../../../docs/sdk/README.md"))).toEqual([])
  expect(missing(names, read("../../../docs/sdk/README.en.md"))).toEqual([])
})
