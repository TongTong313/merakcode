/**
 * Finds Chinese where English is expected: code comments, log messages and test titles (user-facing text lives in
 * the locale files). A line after `// i18n-allow` is skipped, for keyword lists that must stay Chinese.
 *   node --import ./script/node/register.mjs script/check-comments.ts [path prefix ...]            fail if found
 *   node --import ./script/node/register.mjs script/check-comments.ts --report [path prefix ...]   count per file
 */
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { parseSync } from "oxc-parser"

export type Issue = { line: number; kind: "comment" | "log" | "test"; text: string }

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff01-\uff60]/
const LOG = new Set(["debug", "info", "warn", "error"])
const TESTS = new Set(["describe", "test", "it"])
const SCRIPT = /\.(m|c)?(t|j)sx?$/
const HASH = /\.(sh|ps1|ya?ml)$/

type Node = { type: string; start: number; end: number; [key: string]: unknown }

function hashComments(text: string): Issue[] {
  return text.split(/\r?\n/).flatMap((line, index) => {
    const at = line.trimStart().startsWith("#") ? line.indexOf("#") : line.indexOf(" #")
    const comment = at < 0 ? "" : line.slice(at)
    return CJK.test(comment) ? [{ line: index + 1, kind: "comment" as const, text: comment.trim() }] : []
  })
}

/** Name of what is being called: log.info → ["log", "info"], test.skip → ["test", "skip"] */
function callee(node: Node | undefined): string[] {
  if (!node) return []
  if (node.type === "Identifier") return [String(node.name)]
  if (node.type === "MemberExpression") {
    const property = node.property as Node
    return [...callee(node.object as Node), property.type === "Identifier" ? String(property.name) : ""]
  }
  if (node.type === "CallExpression") return callee(node.callee as Node)
  return []
}

export function issues(file: string, text: string): Issue[] {
  if (HASH.test(file)) return hashComments(text)
  const starts = [0, ...[...text.matchAll(/\n/g)].map((match) => match.index! + 1)]
  const line = (offset: number) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (starts[mid]! <= offset) low = mid
      else high = mid - 1
    }
    return low + 1
  }
  const parsed = parseSync(file, text)
  const found = new Map<number, Issue>()
  const allowed = new Set(
    parsed.comments.filter((comment) => comment.value.includes("i18n-allow")).map((comment) => line(comment.end) + 1),
  )

  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit)
    if (!value || typeof value !== "object") return
    const node = value as Node
    if (node.type === "CallExpression") {
      const name = callee(node.callee as Node)
      const first = (node.arguments as Node[])[0]
      const literal = first && (first.type === "Literal" || first.type === "TemplateLiteral")
      const source = literal ? text.slice(first.start, first.end) : ""
      const kind =
        name.length >= 2 && /log$/i.test(name.at(-2)!) && LOG.has(name.at(-1)!)
          ? "log"
          : TESTS.has(name[0]!)
            ? "test"
            : undefined
      if (kind && CJK.test(source)) found.set(line(first!.start), { line: line(first!.start), kind, text: source })
    }
    for (const [key, child] of Object.entries(node)) if (key !== "parent" && typeof child === "object") visit(child)
  }
  visit(parsed.program)

  for (const comment of parsed.comments) {
    const at = line(comment.start)
    if (CJK.test(comment.value) && !found.has(at))
      found.set(at, { line: at, kind: "comment", text: comment.value.trim() })
  }
  return [...found.values()].filter((issue) => !allowed.has(issue.line)).sort((a, b) => a.line - b.line)
}

/** Files to check: tracked and new files, outside locale folders and generated code */
export function files(root: string) {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .filter((file) => existsSync(path.join(root, file)))
    .filter((file) => SCRIPT.test(file) || HASH.test(file))
    .filter((file) => !/(^|\/)(locales|i18n)\//.test(file) && !file.includes("/gen/") && !file.endsWith(".d.ts"))
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dirname, "..")
  const report = process.argv.includes("--report")
  const scope = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))
  const all = files(root)
    .filter((file) => !scope.length || scope.some((prefix) => file.startsWith(prefix)))
    .map((file) => ({ file, found: issues(file, readFileSync(path.join(root, file), "utf8")) }))
    .filter((item) => item.found.length)
  const total = all.reduce((sum, item) => sum + item.found.length, 0)
  if (report) {
    for (const item of all.sort((a, b) => b.found.length - a.found.length))
      console.log(`${String(item.found.length).padStart(5)}  ${item.file}`)
    console.log(`${total} in ${all.length} files`)
  } else if (total) {
    for (const item of all)
      for (const issue of item.found)
        console.error(`${item.file}:${issue.line} ${issue.kind}: ${issue.text.slice(0, 80)}`)
    console.error(`${total} places use Chinese where English is expected (see script/check-comments.ts)`)
    process.exitCode = 1
  }
}
