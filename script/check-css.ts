/**
 * Desktop UI styles must not use !important: styling relies on design tokens and the cascade, and !important makes
 * every later override harder.
 * Usage (from the repository root): pnpm check:css
 */
import path from "node:path"
import { Filesystem } from "@merakcode/util/filesystem"
import { Glob } from "@merakcode/util/glob"

const IMPORTANT = /!\s*important/i

/** Replaces text with spaces of the same length, keeping newlines so line numbers stay put */
const blank = (text: string) => text.replace(/[^\n]/g, " ")

export function violations(files: { path: string; text: string }[]) {
  return files.flatMap((file) => {
    const css = file.path.endsWith(".css")
    // In CSS, comments and strings (content: "…") do not count; in scripts inline styles live in strings, so only
    // comments are stripped
    const code = file.text
      .replace(/\/\*[\s\S]*?\*\//g, blank)
      .replace(css ? /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g : /(^|[^:"'`])\/\/[^\n]*/g, blank)
    return code
      .split("\n")
      .flatMap((line, index) => (IMPORTANT.test(line) ? [{ file: file.path, line: index + 1 }] : []))
  })
}

async function main() {
  const root = path.resolve(import.meta.dirname, "..")
  const paths = new Glob("apps/desktop/renderer/src/**/*.{css,ts,tsx}")
    .scanSync({ cwd: root })
    .map((file) => file.replaceAll("\\", "/"))
  const files = await Promise.all(
    paths.map(async (file) => ({ path: file, text: await Filesystem.readText(path.join(root, file)) })),
  )
  const found = violations(files)
  for (const item of found) console.error(`${item.file}:${item.line} !important`)
  console.log(`${files.length} files checked, ${found.length} !important`)
  if (found.length > 0) process.exitCode = 1
}

if (import.meta.main) await main()
