import type { JSX } from "solid-js"
import { render } from "solid-js/web"
import { afterEach, beforeEach, expect, test } from "vitest"
import { setLocale, t } from "../../i18n"
import { setUi } from "../../state/ui"
import { Frame } from "./frame"

let cleanup = () => {}

beforeEach(() => {
  const host = window as unknown as {
    requestIdleCallback?: (callback: IdleRequestCallback) => number
    cancelIdleCallback?: (id: number) => void
  }
  if (host.requestIdleCallback) return
  host.requestIdleCallback = (callback) =>
    window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 0 }), 0)
  host.cancelIdleCallback = (id) => window.clearTimeout(id)
})

afterEach(() => {
  cleanup()
  cleanup = () => {}
  setUi({ panel: false, tab: "review", maximized: false, terminal: false })
})

function mount(node: () => JSX.Element) {
  setLocale("zh")
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(node, host)
  cleanup = () => {
    dispose()
    host.remove()
  }
  return host
}

/** New conversation: the side panel is open on the review tab, and there is no session yet */
function newConversation() {
  setUi({ panel: true, tab: "review", maximized: false, terminal: false })
  return mount(() => (
    <Frame title="新对话" directory="D:/work" folder="D:/work">
      <h1>要在 test-it 里做什么?</h1>
    </Frame>
  ))
}

test("maximizing the review on a new conversation fills the window with the review", () => {
  const host = newConversation()
  host.querySelector<HTMLButtonElement>(`button[aria-label="${t("panel.maximize")}"]`)!.click()
  expect(host.querySelector("main.review-full")).toBeTruthy()
  expect(host.querySelector("h1")).toBeNull()
})

test("restoring a maximized review on a new conversation brings the conversation back", () => {
  const host = newConversation()
  host.querySelector<HTMLButtonElement>(`button[aria-label="${t("panel.maximize")}"]`)!.click()
  host.querySelector<HTMLButtonElement>(`button[aria-label="${t("panel.restore")}"]`)!.click()
  expect(host.querySelector("main.review-full")).toBeNull()
  expect(host.querySelector("h1")?.textContent).toBe("要在 test-it 里做什么?")
})

test("maximizing the review of an existing conversation fills the window with the review", () => {
  setUi({ panel: true, tab: "review", maximized: false, terminal: false })
  const host = mount(() => (
    <Frame sessionID="s1" title="对话" directory="D:/work" folder="D:/work">
      <h1>对话内容</h1>
    </Frame>
  ))
  host.querySelector<HTMLButtonElement>(`button[aria-label="${t("panel.maximize")}"]`)!.click()
  expect(host.querySelector("main.review-full")).toBeTruthy()
  expect(host.querySelector("h1")).toBeNull()
})
