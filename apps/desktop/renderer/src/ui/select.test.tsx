import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type JSX } from "solid-js"
import { render } from "solid-js/web"
import { expect, test } from "vitest"
import { Select } from "./select"

const baseStyles = readFileSync(join(import.meta.dirname, "../styles/base.css"), "utf8")

const options = [
  {
    value: "alibaba-cn/qwen3.5-flash",
    label: "Qwen3.5 Flash",
    description: "Alibaba (China)",
    providerID: "alibaba-cn",
  },
  { value: "anthropic/claude", label: "Claude", description: "Anthropic", providerID: "anthropic" },
]

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

test("the open model menu shows each model's provider logo and name", () => {
  const view = mount(() => (
    <Select label="Default model" options={options} value="anthropic/claude" onChange={() => {}} />
  ))
  view.host
    .querySelector("button")
    ?.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, pointerType: "mouse" }))
  const menu = document.body.textContent ?? ""
  expect(menu).toContain("Qwen3.5 Flash")
  expect(menu).toContain("Alibaba (China)")
  expect(menu).toContain("Claude")
  expect(menu).toContain("Anthropic")
  const styles = [...document.body.querySelectorAll("span")].map((el) => el.getAttribute("style") ?? "")
  expect(styles.filter((style) => /svg/i.test(style)).length).toBeGreaterThanOrEqual(2)
  view.cleanup()
})

test("an empty model select shows the placeholder and no logo", () => {
  const view = mount(() => (
    <Select
      label="Small model"
      options={options}
      value={undefined}
      placeholder="Automatic per provider"
      onChange={() => {}}
    />
  ))
  expect(view.host.textContent).toContain("Automatic per provider")
  const styles = [...view.host.querySelectorAll("span")].map((el) => el.getAttribute("style") ?? "")
  expect(styles.some((style) => /svg/i.test(style))).toBe(false)
  view.cleanup()
})

test("an open select menu keeps its options flush with the menu padding", () => {
  // Vitest does not insert stylesheets into happy-dom, so the test applies the real sheet.
  const sheet = document.createElement("style")
  sheet.textContent = baseStyles
  document.head.append(sheet)
  const view = mount(() => (
    <Select label="Default model" options={options} value="anthropic/claude" onChange={() => {}} />
  ))
  try {
    view.host
      .querySelector("button")
      ?.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, pointerType: "mouse" }))
    const list = document.querySelector('[role="listbox"]')
    const style = getComputedStyle(list!)
    expect(style.paddingLeft).toBe("0px")
    expect(style.marginTop).toBe("0px")
    expect(style.marginBottom).toBe("0px")
  } finally {
    view.cleanup()
    sheet.remove()
  }
})

test("the closed model select shows the selected model and its provider logo", () => {
  const view = mount(() => (
    <Select label="Default model" options={options} value="anthropic/claude" onChange={() => {}} />
  ))
  expect(view.host.textContent).toContain("Claude")
  const styles = [...view.host.querySelectorAll("span")].map((el) => el.getAttribute("style") ?? "")
  expect(styles.some((style) => /svg/i.test(style))).toBe(true)
  view.cleanup()
})

test("a select inside a dialog opens its list inside the dialog, so the modal never hides it from assistive tech", async () => {
  const { Dialog } = await import("./dialog")
  const view = mount(() => (
    <Dialog open title="New group" onOpenChange={() => {}}>
      <Select label="Product" options={options} value="anthropic/claude" onChange={() => {}} />
    </Dialog>
  ))
  const dialog = document.querySelector("[role=dialog]")!
  dialog
    .querySelector("button[aria-haspopup]")
    ?.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, pointerType: "mouse" }))
  const list = document.querySelector("[role=listbox]")
  expect(list).not.toBeNull()
  expect(dialog.contains(list)).toBe(true)
  view.cleanup()
})
