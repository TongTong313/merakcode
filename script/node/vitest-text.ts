import type { Plugin } from "vite"

/**
 * Text imports: both `import x from "./a.txt"` and `import x from "./a.md" with { type: "text" }` import a string.
 * They are rewritten to Vite's built-in `?raw`, so tests and bundling follow the same rules.
 */
export function text(): Plugin {
  const attributed = /(from\s+["'])([^"']+)(["'])\s+with\s*\{\s*type:\s*["']text["']\s*\}/g
  const plain = /(from\s+["'])([^"']+\.txt)(["'])/g
  return {
    name: "merakcode:text",
    enforce: "pre",
    transform(code, id) {
      if (!/\.[cm]?[jt]sx?$/.test(id.split("?")[0] ?? id)) return
      if (!code.includes(".txt") && !code.includes('type: "text"') && !code.includes("type: 'text'")) return
      const out = code.replace(attributed, "$1$2?raw$3").replace(plain, "$1$2?raw$3")
      return out === code ? undefined : { code: out, map: null }
    },
  }
}
