/**
 * Markdown → safe HTML: marked parses, KaTeX typesets math (with MathML), DOMPurify sanitizes (model output may contain
 * HTML). Code blocks render as plain text first and are swapped once highlighted; results are cached by language and
 * code so streaming re-renders do not flicker.
 */
import DOMPurify from "dompurify"
import { Marked, type Tokens } from "marked"
import markedKatex from "marked-katex-extension"
import "katex/dist/katex.min.css"
import { highlightHtml } from "./highlight"

const cache = new Map<string, string>()
const key = (lang: string, code: string) => `${lang}\u0000${code}`

const escape = (text: string) =>
  text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!)

const marked = new Marked({ gfm: true, breaks: false })
marked.use(markedKatex({ throwOnError: false, nonStandard: true }))
marked.use({
  renderer: {
    code(token: Tokens.Code) {
      const lang = (token.lang ?? "").split(/\s/)[0] ?? ""
      const cached = cache.get(key(lang, token.text))
      const body = cached ?? `<pre class="shiki"><code>${escape(token.text)}</code></pre>`
      return `<div class="code-block-wrap" data-lang="${escape(lang)}" data-code="${encodeURIComponent(token.text)}">${body}</div>`
    },
    link(token: Tokens.Link) {
      return `<a href="${escape(token.href)}" title="${escape(token.title ?? token.href)}">${this.parser.parseInline(token.tokens)}</a>`
    },
  },
})

export function render(text: string) {
  const html = marked.parse(text, { async: false })
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, mathMl: true, svg: true },
    ADD_ATTR: ["data-lang", "data-code"],
    FORBID_TAGS: ["style", "form", "input", "button"],
  })
}

/** Highlights code blocks not yet in the cache; returns whether any were added, so the caller can re-render */
export async function highlightPending(root: HTMLElement) {
  const blocks = [...root.querySelectorAll<HTMLElement>(".code-block-wrap")]
  const results = await Promise.all(
    blocks.map(async (block) => {
      const lang = block.dataset.lang ?? ""
      const code = decodeURIComponent(block.dataset.code ?? "")
      if (!lang || cache.has(key(lang, code))) return false
      const html = await highlightHtml(code, lang).catch(() => undefined)
      if (!html) return false
      cache.set(key(lang, code), html)
      if (cache.size > 500) cache.delete(cache.keys().next().value!)
      return true
    }),
  )
  return results.some(Boolean)
}
