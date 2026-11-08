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
  setUi({ palette: false, settings: undefined })
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

test("opens settings from the command palette", () => {
  setState("folders", [])
  open()
  option("设置").click()
  expect(ui.settings).toBe("general")
  expect(ui.palette).toBe(false)
})
