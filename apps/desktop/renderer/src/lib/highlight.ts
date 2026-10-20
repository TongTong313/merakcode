/**
 * Syntax highlighting (fine-grained shiki bundle with the JS regex engine, so no wasm). Languages load on demand, and
 * light and dark themes render together as CSS variables (--shiki-light / --shiki-dark), so switching themes needs
 * no re-highlighting.
 */
import { createHighlighterCore, type HighlighterCore, type ThemedToken } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"
import { bundledLanguages, bundledLanguagesAlias } from "shiki/langs"

let core: Promise<HighlighterCore> | undefined
const highlighter = () =>
  (core ??= createHighlighterCore({
    themes: [import("shiki/themes/github-light-default.mjs"), import("shiki/themes/github-dark-default.mjs")],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  }))

const EXTENSIONS: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  ps1: "powershell",
  json: "json",
  jsonc: "jsonc",
  md: "markdown",
  mdx: "mdx",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  html: "html",
  vue: "vue",
  svelte: "svelte",
  css: "css",
  scss: "scss",
  less: "less",
  sql: "sql",
  xml: "xml",
  dockerfile: "docker",
  lua: "lua",
  dart: "dart",
  zig: "zig",
}

/** Guesses the language from the file name */
export function languageOf(file: string) {
  const name = file.split(/[\\/]/).pop()?.toLowerCase() ?? ""
  if (name === "dockerfile") return "docker"
  if (name === "makefile") return "make"
  return EXTENSIONS[name.split(".").pop() ?? ""]
}

/** Known language id (aliases included), or undefined */
function resolve(lang: string | undefined) {
  if (!lang) return
  const id = lang.toLowerCase()
  if (id in bundledLanguages) return id
  if (id in bundledLanguagesAlias) return id
}

async function load(lang: string | undefined) {
  const id = resolve(lang)
  if (!id) return
  const instance = await highlighter()
  if (!instance.getLoadedLanguages().includes(id)) {
    const loader =
      (bundledLanguages as Record<string, () => Promise<unknown>>)[id] ??
      (bundledLanguagesAlias as Record<string, () => Promise<unknown>>)[id]
    await instance.loadLanguage((await loader!()) as never)
  }
  return { instance, id }
}

const themes = { light: "github-light-default", dark: "github-dark-default" }

/** Highlights a whole snippet to HTML (for markdown code blocks) */
export async function highlightHtml(code: string, lang: string | undefined) {
  const loaded = await load(lang)
  if (!loaded) return
  return loaded.instance.codeToHtml(code, { lang: loaded.id, themes, defaultColor: false })
}

/** Tokens per line, for diffs: before and after are highlighted once each, then looked up by line number */
export async function highlightLines(code: string, lang: string | undefined): Promise<ThemedToken[][] | undefined> {
  const loaded = await load(lang)
  if (!loaded) return
  return loaded.instance.codeToTokens(code, { lang: loaded.id, themes, defaultColor: false }).tokens
}
