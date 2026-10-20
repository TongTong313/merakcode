import { describe, expect, test } from "vitest"
import type { ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { For } from "solid-js"
import {
  canConsumeVerticalScroll,
  handleNestedVerticalScroll,
} from "../../src/cli/cmd/tui/routes/session/nested-scroll"

describe("nested session scrolling", () => {
  test("detects whether the inner viewport can consume the requested direction", () => {
    const metrics = { scrollTop: 0, scrollHeight: 12, viewportHeight: 4 }

    expect(canConsumeVerticalScroll(metrics, "up")).toBe(false)
    expect(canConsumeVerticalScroll(metrics, "down")).toBe(true)
    expect(canConsumeVerticalScroll({ ...metrics, scrollTop: 4 }, "up")).toBe(true)
    expect(canConsumeVerticalScroll({ ...metrics, scrollTop: 8 }, "down")).toBe(false)
    expect(canConsumeVerticalScroll({ scrollTop: 0, scrollHeight: 4, viewportHeight: 4 }, "down")).toBe(false)
  })

  test("keeps wheel input in the inner viewport until it reaches the boundary", async () => {
    let outer: ScrollBoxRenderable
    let inner: ScrollBoxRenderable
    const setup = await testRender(
      () => (
        <scrollbox ref={(value) => (outer = value)} width={30} height={4}>
          <scrollbox ref={(value) => (inner = value)} width={24} height={2} onMouseScroll={handleNestedVerticalScroll}>
            <For each={Array.from({ length: 10 }, (_, index) => `inner ${index}`)}>{(row) => <text>{row}</text>}</For>
          </scrollbox>
          <For each={Array.from({ length: 10 }, (_, index) => `outer ${index}`)}>{(row) => <text>{row}</text>}</For>
        </scrollbox>
      ),
      { width: 40, height: 12 },
    )

    try {
      await setup.flush()
      const x = inner!.screenX + 1
      const y = inner!.screenY + 1

      await setup.mockMouse.scroll(x, y, "down")
      await setup.flush()
      expect(inner!.scrollTop).toBeGreaterThan(0)
      expect(outer!.scrollTop).toBe(0)

      inner!.scrollTo(inner!.scrollHeight)
      await setup.flush()
      const outerBefore = outer!.scrollTop
      await setup.mockMouse.scroll(x, y, "down")
      await setup.flush()
      expect(inner!.scrollTop).toBe(inner!.scrollHeight - inner!.viewport.height)
      expect(outer!.scrollTop).toBeGreaterThan(outerBefore)

      inner!.scrollTo(0)
      outer!.scrollTo(outer!.scrollHeight)
      await setup.flush()
      const outerAtBottom = outer!.scrollTop
      await setup.mockMouse.scroll(x, y, "up")
      await setup.flush()
      expect(inner!.scrollTop).toBe(0)
      expect(outer!.scrollTop).toBeLessThan(outerAtBottom)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("lets the outer viewport scroll when the inner content does not overflow", async () => {
    let outer: ScrollBoxRenderable
    let inner: ScrollBoxRenderable
    const setup = await testRender(
      () => (
        <scrollbox ref={(value) => (outer = value)} width={30} height={4}>
          <scrollbox ref={(value) => (inner = value)} width={24} height={2} onMouseScroll={handleNestedVerticalScroll}>
            <text>short inner content</text>
          </scrollbox>
          <For each={Array.from({ length: 10 }, (_, index) => `outer ${index}`)}>{(row) => <text>{row}</text>}</For>
        </scrollbox>
      ),
      { width: 40, height: 12 },
    )

    try {
      await setup.flush()
      await setup.mockMouse.scroll(inner!.screenX + 1, inner!.screenY + 1, "down")
      await setup.flush()
      expect(inner!.scrollTop).toBe(0)
      expect(outer!.scrollTop).toBeGreaterThan(0)
    } finally {
      setup.renderer.destroy()
    }
  })
})
