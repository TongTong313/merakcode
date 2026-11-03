import { render } from "solid-js/web"
import { afterEach, expect, test, vi } from "vitest"
import { setLocale } from "../../i18n"
import { SandboxField } from "./sandbox-control"
import { Toasts } from "../../ui/toast"

const native = vi.hoisted(() => ({ values: new Map<string, string>(), installs: 0 }))
vi.mock("../../lib/bridge", () => ({
  bridge: { os: "windows" },
  mac: false,
  log: () => {},
  storage: {
    get: async (key: string, fallback: unknown) => JSON.parse(native.values.get(key) ?? JSON.stringify(fallback)),
    set: async (key: string, value: unknown) => void native.values.set(key, JSON.stringify(value)),
  },
}))
vi.mock("undici", () => ({
  Agent: class {},
  fetch: async (url: string) => {
    if (url.includes("/sandbox/install")) {
      native.installs++
      return Response.json({ message: "administrator approval was not given" }, { status: 500 })
    }
    return Response.json({ status: "unsupported", installable: true, reason: "setup required" })
  },
}))

const disposers: (() => void)[] = []
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose())
  native.values.clear()
  native.installs = 0
})

function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(
    () => (
      <>
        <SandboxField directory="/first-interactive" />
        <Toasts />
      </>
    ),
    host,
  )
  disposers.push(() => {
    dispose()
    host.remove()
  })
  return host
}

test("Windows setup explains the administrator request once and cancellation does not prompt again", async () => {
  setLocale("zh")
  mount()
  await vi.waitFor(() => expect(native.installs).toBe(1))
  expect(document.body.textContent).toContain("Windows 将请求一次管理员确认")
  await vi.waitFor(() => expect(document.body.textContent).toContain("administrator approval was not given"))
  const reopened = mount()
  await vi.waitFor(() => expect(reopened.textContent).toContain("未启动"))
  expect(native.installs).toBe(1)
  const buttons = [...document.querySelectorAll("button")].filter((button) => button.querySelector(".lucide-shield"))
  buttons.at(-1)?.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, pointerType: "mouse" }))
  const retry = [...document.querySelectorAll("[role=option]")].find((option) =>
    option.textContent?.includes("设置并启动"),
  )
  retry?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  await vi.waitFor(() => expect(native.installs).toBe(2))
})
