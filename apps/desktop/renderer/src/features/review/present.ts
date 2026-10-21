const FLASH_MS = 1500

/** Scrolls an element to the middle of its scroller and highlights it briefly */
export function present(element: Element) {
  element.classList.add("flash")
  element.scrollIntoView({ block: "center", behavior: "smooth" })
  window.setTimeout(() => element.classList.remove("flash"), FLASH_MS)
}
