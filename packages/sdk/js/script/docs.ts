/**
 * Keeps the SDK guide (docs/sdk/README.md and README.en.md) honest: every hand-written export in api.md must be
 * mentioned in both languages, and every ```ts block must compile against the current SDK.
 * The blocks are written to examples/.doc (git-ignored) and checked with the SDK's own tsc.
 *
 * Usage (repo root): pnpm check:sdk-docs
 */
import { spawnSync } from "node:child_process"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"

/** Names declared in api.md; generated exports are only counted there, never listed */
export function exported(api: string) {
  const names = api
    .split("\n")
    .map((line) => /^(?:function|type|class|interface|const|enum) (\w+)/.exec(line)?.[1])
    .filter((name): name is string => !!name)
  return [...new Set(names)]
}

export function missing(names: string[], doc: string) {
  return names.filter((name) => !new RegExp(`\\b${name}\\b`).test(doc))
}

/** The ts blocks; one importing the single-file adapter library is checked against the SDK's adapter entry, its source */
export function snippets(markdown: string) {
  return [...markdown.matchAll(/^```ts\n([\s\S]*?)^```$/gm)].map((match) =>
    match[1]!.replaceAll('from "./merakcode-adapter.mjs"', 'from "@merakcode/sdk/adapter"'),
  )
}

async function main() {
  const root = path.resolve(import.meta.dirname, "..")
  const docs = path.resolve(root, "../../../docs/sdk")
  const guides = { zh: path.join(docs, "README.md"), en: path.join(docs, "README.en.md") }
  const names = exported(await readFile(path.join(root, "api.md"), "utf8"))
  const out = path.join(root, "examples", ".doc")
  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })
  await writeFile(path.join(out, "tsconfig.json"), JSON.stringify({ extends: "../tsconfig.json", include: ["*.ts"] }))

  const problems: string[] = []
  for (const [lang, file] of Object.entries(guides)) {
    const text = (await readFile(file, "utf8")).replaceAll("\r\n", "\n")
    const gaps = missing(names, text)
    if (gaps.length) problems.push(`${path.relative(process.cwd(), file)} does not mention: ${gaps.join(", ")}`)
    for (const [index, code] of snippets(text).entries())
      await writeFile(path.join(out, `${lang}-${String(index + 1).padStart(2, "0")}.ts`), code)
  }

  const tsc = createRequire(path.join(root, "package.json")).resolve("typescript/bin/tsc")
  const compiled = spawnSync(process.execPath, [tsc, "-p", out], { stdio: "inherit" })
  if (compiled.status !== 0)
    problems.push(
      `Code blocks in the SDK guide do not compile; the extracted files are in ${path.relative(process.cwd(), out)}`,
    )

  for (const problem of problems) console.error(problem)
  if (problems.length) process.exitCode = 1
}

if (import.meta.main) await main()
