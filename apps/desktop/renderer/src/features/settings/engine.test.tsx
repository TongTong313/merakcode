import { render } from "solid-js/web"
import { afterEach, beforeAll, expect, test } from "vitest"
import type { DesktopBridge } from "../../desktop/bridge-contract"
import { setLocale, t } from "../../i18n"

/** The main process owns the login item; the page only talks to it through the bridge */
const calls: boolean[] = []
let enabled = false
let failure: Error | undefined
let engineSettings: typeof import("./engine").EngineSettings
let toasts: typeof import("../../ui/toast").Toasts

beforeAll(async () => {
  window.__MERAKCODE_DESKTOP__ = {
    getLoginItem: async () => enabled,
    setLoginItem: async (value: boolean) => {
      calls.push(value)
      if (failure) throw failure
      enabled = value
      return enabled
    },
  } as unknown as DesktopBridge
  engineSettings = (await import("./engine")).EngineSettings
  toasts = (await import("../../ui/toast")).Toasts
})

let dispose = () => {}
afterEach(() => {
  dispose()
  document.body.replaceChildren()
  calls.length = 0
  enabled = false
  failure = undefined
})

function show() {
  const host = document.createElement("div")
  document.body.append(host)
  const Page = engineSettings
  const Toasts = toasts
  dispose = render(
    () => (
      <>
        <Page />
        <Toasts />
      </>
    ),
    host,
  )
  return host
}

const login = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find((item) =>
    item.textContent?.includes(t("settings.engine.login")),
  )

test("the background engine page has a start-at-login switch that is off by default", async () => {
  setLocale("zh")
  const host = show()
  expect(host.querySelector("h1")?.textContent).toBe("后台引擎")
  await expect.poll(() => login(host)?.getAttribute("aria-checked")).toBe("false")
  expect(login(host)?.textContent).toContain("登录时启动")
})

test("flipping the switch asks the main process and shows the answer; flipping back turns it off", async () => {
  setLocale("en")
  const host = show()
  await expect.poll(() => login(host)).toBeDefined()
  login(host)!.click()
  await expect.poll(() => login(host)?.getAttribute("aria-checked")).toBe("true")
  login(host)!.click()
  await expect.poll(() => login(host)?.getAttribute("aria-checked")).toBe("false")
  expect(calls).toEqual([true, false])
})

test("it shows the state the main process has when the page opens", async () => {
  setLocale("en")
  enabled = true
  const host = show()
  await expect.poll(() => login(host)?.getAttribute("aria-checked")).toBe("true")
})

test("a refusal by the system leaves the switch off and shows the error", async () => {
  setLocale("zh")
  failure = new Error("MRK-5014")
  const host = show()
  await expect.poll(() => login(host)).toBeDefined()
  login(host)!.click()
  await expect.poll(() => host.textContent).toContain("MRK-5014")
  expect(login(host)?.getAttribute("aria-checked")).toBe("false")
  expect(calls).toEqual([true])
})
