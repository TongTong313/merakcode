import { createResource } from "solid-js"
import { render } from "solid-js/web"
import { afterEach, expect, test } from "vitest"
import { setLocale, t } from "../../i18n"
import { Startup } from "./startup"

let cleanup = () => {}
const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  cleanup()
  cleanup = () => {}
})

// The engine refused the first config read at startup and the window stayed on its logo with no way forward
test("a failed startup shows the error with a retry, and the retry brings up the app", async () => {
  setLocale("zh")
  let attempts = 0
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(() => {
    const [ready, { refetch }] = createResource(async () => {
      attempts++
      if (attempts === 1) throw new Error("This endpoint is not available to this process")
      return true
    })
    return (
      <Startup ready={ready} onRetry={() => void refetch()}>
        <p>app</p>
      </Startup>
    )
  }, host)
  cleanup = () => {
    dispose()
    host.remove()
  }

  await settled()
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(t("error.offline"))
  const retry = [...host.querySelectorAll("button")].find((button) => button.textContent === t("error.retry"))
  retry!.click()
  await settled()
  expect(attempts).toBe(2)
  expect(host.textContent).toBe("app")
})
