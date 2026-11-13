import { createSignal, type JSX } from "solid-js"
import { render } from "solid-js/web"
import { afterEach, beforeEach, expect, test } from "vitest"
import { setLocale, t } from "../../i18n"
import { setUi } from "../../state/ui"
import { selectPanels } from "../panel/workspace"
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
  setUi({ panel: false, maximized: false })
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
async function newConversation() {
  const state = await selectPanels({ directory: "D:/work" })
  state.open({ kind: "review" })
  setUi({ panel: true, maximized: false })
  return mount(() => (
    <Frame title="新对话" directory="D:/work" folder="D:/work">
      <h1>要在 test-it 里做什么?</h1>
    </Frame>
  ))
}

test("maximizing the review on a new conversation fills the window with the review", async () => {
  const host = await newConversation()
  host.querySelector<HTMLButtonElement>(`button[aria-label="${t("panel.maximize")}"]`)!.click()
  expect(host.querySelector("main.review-full")).toBeTruthy()
  expect(host.querySelector("h1")).toBeNull()
})

test("restoring a maximized review on a new conversation brings the conversation back", async () => {
  const host = await newConversation()
  host.querySelector<HTMLButtonElement>(`button[aria-label="${t("panel.maximize")}"]`)!.click()
  host.querySelector<HTMLButtonElement>(`button[aria-label="${t("panel.restore")}"]`)!.click()
  expect(host.querySelector("main.review-full")).toBeNull()
  expect(host.querySelector("h1")?.textContent).toBe("要在 test-it 里做什么?")
})

test("maximizing the review of an existing conversation fills the window with the review", async () => {
  setUi({ panel: true, maximized: false })
  const state = await selectPanels({ directory: "D:/work", sessionID: "s1" })
  state.open({ kind: "review" })
  const host = mount(() => (
    <Frame sessionID="s1" title="对话" directory="D:/work" folder="D:/work">
      <h1>对话内容</h1>
    </Frame>
  ))
  host.querySelector<HTMLButtonElement>(`button[aria-label="${t("panel.maximize")}"]`)!.click()
  expect(host.querySelector("main.review-full")).toBeTruthy()
  expect(host.querySelector("h1")).toBeNull()
})

test("a maximized review stays maximized when the conversation is told about again with the same folder and id", async () => {
  setUi({ panel: true, maximized: false })
  const directory = "d:/work"
  const state = await selectPanels({ directory, sessionID: "s2" })
  state.open({ kind: "review" })
  // The page reads the folder from the conversation's record, which is announced again whenever the record changes
  const [info, setInfo] = createSignal({ directory }, { equals: false })
  const host = mount(() => (
    <Frame sessionID="s2" title="对话" directory={info().directory} folder={directory}>
      <h1>对话内容</h1>
    </Frame>
  ))
  host.querySelector<HTMLButtonElement>(`button[aria-label="${t("panel.maximize")}"]`)!.click()
  expect(host.querySelector("main.review-full")).toBeTruthy()
  setInfo({ directory })
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(host.querySelector("main.review-full")).toBeTruthy()
})

test("a maximized review closes when the conversation moves to another folder", async () => {
  setUi({ panel: true, maximized: false })
  const first = "d:/work"
  const second = "d:/other"
  const state = await selectPanels({ directory: first, sessionID: "s3" })
  state.open({ kind: "review" })
  const [directory, setDirectory] = createSignal(first)
  const host = mount(() => (
    <Frame sessionID="s3" title="对话" directory={directory()} folder={first}>
      <h1>对话内容</h1>
    </Frame>
  ))
  host.querySelector<HTMLButtonElement>(`button[aria-label="${t("panel.maximize")}"]`)!.click()
  expect(host.querySelector("main.review-full")).toBeTruthy()
  setDirectory(second)
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(host.querySelector("main.review-full")).toBeNull()
})
