import { Route, Router } from "@solidjs/router"
import { render } from "solid-js/web"
import { afterAll, beforeAll, afterEach, expect, test } from "vitest"
import { engineFixture } from "../../test/engine"
import { client } from "../../state/client"
import { Home, Workspace } from "../../app"
import { setLocale, t } from "../../i18n"
import { storage } from "../../lib/bridge"
import { sessionPath } from "../../lib/route"
import { setState } from "../../state/store"

const alpha = "D:/work/alpha"
const beta = "D:/work/beta"

let engine: Awaited<ReturnType<typeof engineFixture>>
beforeAll(async () => {
  engine = await engineFixture()
  location.href = engine.url
})
afterAll(async () => {
  try {
    await (await client()).close()
  } finally {
    await engine.close()
  }
})
let cleanup = () => {}
const settled = async (removed: string) => {
  await expect.poll(() => names(), { timeout: 5000 }).not.toContain(removed)
}

afterEach(() => {
  cleanup()
  cleanup = () => {}
  setState("folders", [])
  localStorage.clear()
  window.history.replaceState({}, "", "/")
})

function press(el: Element) {
  const event = { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" } as const
  el.dispatchEvent(new PointerEvent("pointerdown", event))
  el.dispatchEvent(new PointerEvent("pointerup", event))
}

const names = () => [...document.querySelectorAll("section[aria-label]")].map((el) => el.getAttribute("aria-label"))

/** Shows directory, with the given projects already in the sidebar. The route may name one that is not listed yet. */
function open(directory: string, folders: string[]) {
  setLocale("zh")
  setState(
    "folders",
    folders.map((folder) => ({ directory: folder })),
  )
  window.history.replaceState({}, "", sessionPath(directory))
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <Router>
        <Route path="/" component={Home} />
        <Route path="/:dir/session/:id?" component={Workspace} />
      </Router>
    ),
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
}

function remove(name: string) {
  const group = document.querySelector(`section[aria-label="${name}"]`)
  const trigger = group?.querySelector(`button[aria-label="${t("sidebar.projectMenu")}"]`)
  if (!trigger) throw new Error(`project menu for ${name} is not on screen`)
  press(trigger)
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) =>
    el.textContent?.includes(t("sidebar.removeProject")),
  )
  if (!item) throw new Error("remove from list is not in the menu")
  press(item)
}

test("removing the open project takes it off the sidebar and the saved list", async () => {
  open(alpha, [alpha, beta])
  remove("alpha")
  await settled("alpha")
  expect(names()).toEqual(["beta"])
  expect(await storage.get<string[]>("folders", [])).toEqual([beta])
})

test("removing the open project continues in the next project", async () => {
  open(alpha, [alpha, beta])
  remove("alpha")
  await settled("alpha")
  expect(document.querySelector("h1")?.textContent).toBe(t("compose.heading", { name: "beta" }))
})

test("removing the only project returns to the home screen", async () => {
  open(alpha, [alpha])
  remove("alpha")
  await settled("alpha")
  expect(document.querySelector("h1")?.textContent).toBe(t("home.title"))
  expect(document.querySelector("section[aria-label]")).toBeNull()
  expect(await storage.get<string[]>("folders", [])).toEqual([])
})

test("removing a project that is not open leaves the current one on screen", async () => {
  open(alpha, [alpha, beta])
  remove("beta")
  await settled("beta")
  expect(document.querySelector("h1")?.textContent).toBe(t("compose.heading", { name: "alpha" }))
  expect(names()).toEqual(["alpha"])
  expect(await storage.get<string[]>("folders", [])).toEqual([alpha])
})

test("removing a project the route just added keeps it off the list", async () => {
  open(alpha, [beta])
  remove("alpha")
  await settled("alpha")
  expect(names()).toEqual(["beta"])
  expect(document.querySelector("h1")?.textContent).toBe(t("compose.heading", { name: "beta" }))
  expect(await storage.get<string[]>("folders", [])).toEqual([beta])
})
