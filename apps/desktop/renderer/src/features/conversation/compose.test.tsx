import { Route, Router } from "@solidjs/router"
import { render } from "solid-js/web"
import { afterEach, expect, test, vi } from "vitest"
import { setLocale } from "../../i18n"
import { Compose } from "./compose"

const requests = vi.hoisted(() => [] as { url: string; method: string }[])
vi.mock("undici", () => ({
  Agent: class {},
  fetch: async (url: string, init?: { method?: string }) => {
    requests.push({ url: String(url), method: init?.method ?? "GET" })
    const capabilities = {
      modelSelection: true,
      modelDiscovery: false,
      textStreaming: true,
      resume: true,
      permission: "merak",
      questions: true,
    }
    const body = String(url).includes("/agent-connection/product")
      ? [
          {
            id: "merak",
            title: "MerakCode",
            connected: true,
            enabled: true,
            builtin: true,
            source: "builtin",
            revision: 0,
            capabilities,
          },
          {
            id: "claude",
            title: "Claude Code",
            connected: true,
            enabled: true,
            builtin: true,
            source: "builtin",
            revision: 0,
            capabilities,
          },
        ]
      : []
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
  },
}))
let cleanup = () => {}
afterEach(() => {
  cleanup()
  window.history.replaceState({}, "", "/")
})

test("a new conversation selects its product without creating a session", async () => {
  setLocale("zh")
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <Router>
        <Route path="/" component={() => <Compose directory="/target-selection" />} />
      </Router>
    ),
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
  await vi.waitFor(() => expect(host.querySelector('button[aria-label="对话对象"]')).not.toBeNull())
  const picker = host.querySelector<HTMLButtonElement>('button[aria-label="对话对象"]')!
  await vi.waitFor(() => expect(picker.disabled).toBe(false))
  expect(picker.textContent).toContain("MerakCode")
  picker.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, pointerType: "mouse" }))
  const claude = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
    option.textContent?.includes("Claude Code"),
  )!
  expect(claude).toBeDefined()
  claude.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true, pointerType: "mouse" }))
  claude.click()
  expect(picker.textContent).toContain("Claude Code")
  expect(requests.filter((request) => request.method === "POST" && request.url.endsWith("/session"))).toEqual([])
})
