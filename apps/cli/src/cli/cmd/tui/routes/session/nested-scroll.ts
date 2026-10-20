import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core"

type VerticalScrollMetrics = {
  scrollTop: number
  scrollHeight: number
  viewportHeight: number
}

export function canConsumeVerticalScroll(metrics: VerticalScrollMetrics, direction: "up" | "down"): boolean {
  const maxScrollTop = Math.max(0, metrics.scrollHeight - metrics.viewportHeight)
  if (maxScrollTop === 0) return false
  if (direction === "up") return metrics.scrollTop > 0
  return metrics.scrollTop < maxScrollTop
}

export function handleNestedVerticalScroll(this: ScrollBoxRenderable, event: MouseEvent): void {
  if (event.modifiers.shift) return
  const direction = event.scroll?.direction
  if (direction !== "up" && direction !== "down") return

  if (
    canConsumeVerticalScroll(
      {
        scrollTop: this.scrollTop,
        scrollHeight: this.scrollHeight,
        viewportHeight: this.viewport.height,
      },
      direction,
    )
  ) {
    event.stopPropagation()
  }
}
