/**
 * Every `merak <command>` (or `pnpm dev <command>`) written in code in the docs must be a command the CLI really
 * registers. Command names come from the CLI's own --help output; for groups such as `merak sandbox`, the second word
 * is checked against `merak sandbox --help`.
 *
 * Usage: pnpm check:docs
 */
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const root = path.resolve(import.meta.dirname, "..")
const DOCS = [
  "README.md",
  "README.en.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs/errors.md",
  "docs/sdk/README.md",
  "docs/sdk/README.en.md",
]

/**
 * Command words after `merak` or `pnpm dev` in code spans and code blocks, in order, without repeats.
 * ```text blocks hold diagrams and layouts, not commands, so they are skipped.
 */
export function mentioned(markdown: string) {
  const code = [...markdown.matchAll(/^```([^\n]*)\n([\s\S]*?)^```$|`([^`\n]+)`/gm)]
    .filter((match) => match[1]?.trim() !== "text")
    .map((match) => match[2] ?? match[3]!)
  const seen = new Set<string>()
  return code
    .flatMap((code) => [...code.matchAll(/(?:^|\s)(?:merak|pnpm dev)((?: [a-z][a-z-]*){1,2})(?=\s|$|["'`)])/gm)])
    .map((match) => match[1]!.trim().split(" "))
    .filter((words) => {
      const key = words.join(" ")
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

/** Command names and aliases listed in yargs help; a long description pushes the aliases onto the next line */
export function registered(help: string) {
  const lines = help.split("\n")
  return lines.flatMap((line, index) => {
    if (!/^\s+merak /.test(line)) return []
    const [usage, ...rest] = line.trim().split(/\s{2,}/)
    const name = usage!
      .split(" ")
      .slice(1)
      .filter((word) => !/^[[<]/.test(word))
      .at(-1)
    const next = lines[index + 1] ?? ""
    const tail = /^\s+\[aliases: /.test(next) ? next : ""
    const aliases = /\[aliases: ([^\]]+)\]/.exec(rest.join(" ") + tail)?.[1]?.split(", ") ?? []
    return name ? [name, ...aliases] : []
  })
}

function help(...command: string[]) {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(path.join(root, "script/node/register.mjs")).href,
      "--disable-warning=ExperimentalWarning",
      path.join(root, "apps/cli/src/index.ts"),
      ...command,
      "--help",
    ],
    { encoding: "utf8", env: { ...process.env, MERAKCODE_LOCALE: "en-US", NO_COLOR: "1" } },
  )
  return (result.stdout + result.stderr).replace(/\x1b\[[0-9;]*m/g, "")
}

function main() {
  const top = registered(help())
  const groups = new Map<string, string[]>()
  const problems = DOCS.flatMap((file) =>
    mentioned(readFileSync(path.join(root, file), "utf8").replaceAll("\r\n", "\n")).flatMap(([first, second]) => {
      if (!top.includes(first!)) return [`${file}: merak ${first} is not a command`]
      if (!second) return []
      if (!groups.has(first!)) groups.set(first!, registered(help(first!)))
      const sub = groups.get(first!)!
      return sub.length && !sub.includes(second) ? [`${file}: merak ${first} ${second} is not a command`] : []
    }),
  )
  for (const problem of problems) console.error(problem)
  if (problems.length) process.exitCode = 1
}

if (import.meta.main) main()
