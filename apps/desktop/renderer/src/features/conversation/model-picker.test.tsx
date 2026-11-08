import { type JSX } from "solid-js"
import { render } from "solid-js/web"
import { afterEach, expect, test } from "vitest"
import type { CatalogModel } from "@merakcode/sdk"
import { setLocale } from "../../i18n"
import { setState } from "../../state/store"
import { setUi, ui } from "../../state/ui"
import { ModelPicker } from "./model-picker"

let cleanup = () => {}

afterEach(() => {
  cleanup()
  cleanup = () => {}
  setState({ models: [], config: undefined })
  setUi("settings", undefined)
})

function mount(node: () => JSX.Element) {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(node, host)
  cleanup = () => {
    dispose()
    host.remove()
  }
  return host
}

test("add model opens model settings and leaves hidden models out of the menu", () => {
  setLocale("zh")
  const model: CatalogModel = {
    provider: "dashscope",
    id: "qwen-plus",
    window: 128000,
    maxOutput: 16000,
    source: "builtin",
    caps: { tools: true, vision: false, pdf: false },
    thinking: null,
    price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
  setState("models", [model, { ...model, id: "qwen-old" }, { ...model, provider: "relay", id: "claude-sonnet-5" }])
  setState("config", {
    providers: {
      dashscope: {
        name: "Alibaba",
        hasKey: true,
        models: { "qwen-plus": { name: "Qwen-Plus" }, "qwen-old": { name: "Qwen-Old" } },
        picker: { exclude: ["qwen-old"] },
      },
      relay: { name: "packy", baseURL: "http://localhost/v1" },
    },
  })
  const host = mount(() => (
    <ModelPicker value={{ providerID: "dashscope", modelID: "qwen-plus" }} onChange={() => {}} />
  ))
  host.querySelector("button")?.click()
  document.querySelector<HTMLButtonElement>(".model-add")?.click()
  expect(ui.settings).toBe("models")
  const text = document.body.textContent ?? ""
  expect(text).not.toContain("Qwen-Old")
  expect(text).not.toContain("返回")
  // The exit transition keeps the layer mounted until animationend, which happy-dom does not fire.
  const dialog = document.querySelector<HTMLElement>("[role=dialog]")
  dialog?.dispatchEvent(
    new AnimationEvent("animationend", { animationName: dialog ? getComputedStyle(dialog).animationName : "" }),
  )
  expect(document.querySelector('[role="listbox"]')).toBeNull()
})
