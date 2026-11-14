import { type JSX } from "solid-js"
import { render } from "solid-js/web"
import { expect, test } from "vitest"
import { Tip } from "./tooltip"

function mount(node: () => JSX.Element) {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(node, host)
  return {
    host,
    cleanup() {
      dispose()
      host.remove()
    },
  }
}

test("a tooltip stays visual and does not catch the click under it", async () => {
  const view = mount(() => (
    <Tip label="Side panel">
      <button aria-label="Side panel">Side panel</button>
    </Tip>
  ))
  try {
    view.host
      .querySelector("button")!
      .dispatchEvent(new PointerEvent("pointerenter", { bubbles: true, pointerType: "mouse" }))
    await expect.poll(() => document.querySelector(".tooltip")).toBeTruthy()
    const tip = document.querySelector<HTMLElement>(".tooltip")!
    expect(tip.style.getPropertyValue("pointer-events")).toBe("none")
    expect(tip.style.getPropertyPriority("pointer-events")).toBe("important")
    const frame = tip.parentElement
    expect(frame?.hasAttribute("data-popper-positioner")).toBe(true)
    expect(frame?.style.getPropertyValue("pointer-events")).toBe("none")
    expect(frame?.style.getPropertyPriority("pointer-events")).toBe("important")
    tip.style.pointerEvents = "auto"
    await expect.poll(() => tip.style.getPropertyPriority("pointer-events")).toBe("important")
    expect(tip.style.getPropertyValue("pointer-events")).toBe("none")
  } finally {
    view.cleanup()
  }
})
