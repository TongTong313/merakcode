/**
 * Keeps old product names and unfilled placeholders out of the repository.
 * Exceptions go into script/check-brand.allow, one path glob per line. Terms that must not appear in the public
 * repository at all go into script/check-brand.private (git-ignored), one regex per line; a maintainer's checkout
 * checks them too.
 * Usage (repo root): pnpm check:brand
 */
import { execFileSync } from "node:child_process"
import path from "node:path"
import { Filesystem } from "@merakcode/util/filesystem"
import { Glob } from "@merakcode/util/glob"

export type Hit = { file: string; line: number; term: string }

const NAMES = /myth\s*code|\bmyth\b/gi
const OWNER = /\bOWNER\//g
const AUTHOR = /\bAUTHOR\b/g
const BINARY = /\.(png|jpe?g|gif|ico|icns|webp|woff2?|ttf|otf|wasm|zip|gz|pdf|docx|xlsx|pptx)$/i

/** Regexes from check-brand.private: one per line, # starts a comment */
export function privateTerms(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => new RegExp(line, "gi"))
}

function scan(file: string, text: string, pattern: RegExp): Hit[] {
  return text
    .split("\n")
    .flatMap((line, index) => [...line.matchAll(pattern)].map((match) => ({ file, line: index + 1, term: match[0] })))
}

export function violations(files: { path: string; text: string }[], allow: string[] = [], extra: RegExp[] = []) {
  const skip = allow.map((pattern) => new Glob(pattern))
  const terms = new RegExp([NAMES, ...extra].map((item) => item.source).join("|"), "gi")
  return files
    .filter((file) => !skip.some((glob) => glob.match(file.path)))
    .flatMap((file): Hit[] => [
      ...[...file.path.matchAll(NAMES)].map((match) => ({ file: file.path, line: 0, term: match[0] })),
      ...scan(file.path, file.text, terms),
      ...scan(file.path, file.text, OWNER),
      ...(file.path === "LICENSE" ? scan(file.path, file.text, AUTHOR) : []),
    ])
}

async function main() {
  const root = path.resolve(import.meta.dirname, "..")
  const read = (name: string) => Filesystem.readText(path.join(import.meta.dirname, name)).catch(() => "")
  const allow = (await read("check-brand.allow"))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
  const paths = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean)
  const files = await Promise.all(
    paths.map(async (file) => {
      if (BINARY.test(file)) return { path: file, text: "" }
      const text = await Filesystem.readText(path.join(root, file)).catch(() => "")
      return { path: file, text: text.includes("\0") ? "" : text }
    }),
  )
  const found = violations(files, allow, privateTerms(await read("check-brand.private")))
  for (const hit of found) console.error(`${hit.file}:${hit.line} ${hit.term}`)
  console.log(`${files.length} files checked, ${found.length} brand violations`)
  if (found.length > 0) process.exitCode = 1
}

if (import.meta.main) await main()
