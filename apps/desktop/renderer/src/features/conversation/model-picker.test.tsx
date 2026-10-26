import { type JSX } from "solid-js"
import { render } from "solid-js/web"
import { afterEach, expect, test } from "vitest"
import type { ProviderListResponses } from "@merakcode/sdk/client"
import { setLocale } from "../../i18n"
import { setState } from "../../state/store"
import { setUi, ui } from "../../state/ui"
import { ModelPicker } from "./model-picker"

type Providers = ProviderListResponses[200]

let cleanup = () => {}

afterEach(() => {
  cleanup()
  cleanup = () => {}
  setState({ providers: undefined })
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
  const model = {
    release_date: "2026-01-01",
    attachment: false,
    reasoning: false,
    temperature: true,
    tool_call: true,
    options: {},
    limit: { context: 1000, output: 100 },
  }
  setState("providers", {
    all: [
      {
        id: "alibaba-cn",
        name: "Alibaba (China)",
        origin: "official",
        env: [],
        models: {
          "qwen-plus": { ...model, id: "qwen-plus", name: "Qwen-Plus", homepage: true },
          "qwen-old": { ...model, id: "qwen-old", name: "Qwen-Old", homepage: false },
        },
      },
      {
        id: "relay",
        name: "packy",
        origin: "configured",
        env: [],
        models: {
          "claude-sonnet-5": { ...model, id: "claude-sonnet-5", name: "claude-sonnet-5", homepage: true },
        },
      },
    ],
    connected: ["alibaba-cn", "relay"],
    default: { "alibaba-cn": "qwen-plus" },
  } as unknown as Providers)
  const host = mount(() => (
    <ModelPicker value={{ providerID: "alibaba-cn", modelID: "qwen-plus" }} onChange={() => {}} />
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
