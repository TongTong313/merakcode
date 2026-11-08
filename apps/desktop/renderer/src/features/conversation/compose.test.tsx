import { Route, Router } from "@solidjs/router"
import { render } from "solid-js/web"
import { afterAll, afterEach, beforeAll, expect, test } from "vitest"
import { setLocale } from "../../i18n"
import { client } from "../../state/client"
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
