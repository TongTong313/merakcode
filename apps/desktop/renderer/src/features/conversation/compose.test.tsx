import { Route, Router } from "@solidjs/router"
import { render } from "solid-js/web"
import { afterAll, afterEach, beforeAll, expect, test } from "vitest"
import { setLocale } from "../../i18n"
import { client } from "../../state/client"
import { setState } from "../../state/store"
import { engineFixture } from "../../test/engine"
import { Compose } from "./compose"

let cleanup = () => {}
let engine: Awaited<ReturnType<typeof engineFixture>>
beforeAll(async () => {
  engine = await engineFixture()
  location.href = engine.url
  setLocale("en")
})
afterEach(() => {
  cleanup()
  window.history.replaceState({}, "", "/")
})
afterAll(async () => {
  try {
    await (await client()).close()
  } finally {
    await engine.close()
  }
})

function mount() {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <Router>
        <Route path="/" component={() => <Compose directory={engine.project} />} />
      </Router>
    ),
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
  return host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!
}

test("retains an unsent draft across remounts without creating a conversation", async () => {
  const input = mount()
  input.value = "Keep this draft"
  input.dispatchEvent(new InputEvent("input", { bubbles: true }))
  cleanup()
  expect(mount().value).toBe("Keep this draft")
  expect(await (await client()).session.list()).toEqual([])
})

test("creates a real session with the selected full takeover mode", async () => {
  const connection = await client()
  setState("config", { providers: { fake: { hasKey: true } } })
  setState("models", [
    {
      provider: "fake",
      id: "fixture",
      window: 32000,
      maxOutput: 2048,
      source: "builtin",
      thinking: [],
      caps: { tools: true, vision: false, pdf: false },
      price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ])
  const input = mount()
  document
    .querySelector<HTMLButtonElement>('button[aria-label="Permission level"]')!
    .dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, pointerType: "mouse" }))
  ;[...document.querySelectorAll<HTMLElement>('[role="option"]')]
    .find((item) => item.textContent?.includes("Full takeover"))!
    .click()
  await expect
    .poll(() => document.querySelector('[aria-label="Sandbox status"]')?.textContent)
    .toContain("Sandbox disabled")
  input.value = "Start with the selected mode"
  input.dispatchEvent(new InputEvent("input", { bubbles: true }))
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  await expect.poll(async () => (await connection.session.list())?.[0]?.config.mode).toBe("takeover")
})
