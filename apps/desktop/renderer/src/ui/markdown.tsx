import { createEffect, createMemo, createSignal } from "solid-js"
import { bridge } from "../lib/bridge"
import { highlightPending, render } from "../lib/markdown"
import { t } from "../i18n"

const svg = (body: string) =>
  `<svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
const COPY = svg(
  '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
)
const DONE = svg('<path d="M20 6 9 17l-5-5"/>')

/**
 * Renders Markdown: links open in the system browser, code blocks get a copy button and are swapped in once
 * highlighted
 */
export function Markdown(props: { text: string; class?: string }) {
  let root!: HTMLDivElement
  const [version, setVersion] = createSignal(0)
  const html = createMemo(() => {
    version()
    return render(props.text)
  })

  createEffect(() => {
    html()
    queueMicrotask(() => {
      for (const block of root.querySelectorAll<HTMLElement>(".code-block-wrap:not([data-ready])")) {
        block.dataset.ready = ""
        const button = document.createElement("button")
        button.className = "icon-button sm copy"
        button.setAttribute("aria-label", t("common.copy"))
        button.innerHTML = COPY
        block.prepend(button)
      }
      void highlightPending(root).then((changed) => changed && setVersion((value) => value + 1))
    })
  })

  const click = (event: MouseEvent) => {
    const target = event.target as HTMLElement
    const copy = target.closest<HTMLButtonElement>(".copy")
    if (copy) {
      const code = decodeURIComponent(copy.parentElement?.dataset.code ?? "")
      void navigator.clipboard.writeText(code)
      copy.innerHTML = DONE
      setTimeout(() => (copy.innerHTML = COPY), 1200)
      return
    }
    const link = target.closest<HTMLAnchorElement>("a[href]")
    if (!link) return
    event.preventDefault()
    const href = link.getAttribute("href") ?? ""
    if (/^https?:/i.test(href)) void (bridge ? bridge.openExternal(href) : window.open(href, "_blank"))
  }

  return <div ref={root} class={`markdown selectable ${props.class ?? ""}`} innerHTML={html()} onClick={click} />
}
