import { Route, Router } from "@solidjs/router"
import { render } from "solid-js/web"
import { afterEach, expect, test } from "vitest"
import { setLocale } from "../../i18n"
import { setState } from "../../state/store"
import { setUi, ui } from "../../state/ui"
import { Palette } from "./palette"

let cleanup = () => {}

afterEach(() => {
  cleanup()
  cleanup = () => {}
  setUi({ palette: false, newTeam: false })
  setState("folders", [])
})

function open() {
  setLocale("zh")
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <Router>
        <Route path="/" component={Palette} />
      </Router>
    ),
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
  setUi("palette", true)
}

const option = (label: string) =>
  [...document.querySelectorAll<HTMLElement>("[role=option]")].find((item) => item.textContent?.includes(label))!

test("with no project open, New team does nothing, so no dialog pops up once a project opens", () => {
  setState("folders", [])
  open()
  option("新建协作群").click()
  expect(ui.newTeam).toBe(false)
})

test("with a project open, New team opens the dialog", () => {
  setState("folders", [{ directory: "d:/work/alpha" }])
  open()
  option("新建协作群").click()
  expect(ui.newTeam).toBe(true)
})
