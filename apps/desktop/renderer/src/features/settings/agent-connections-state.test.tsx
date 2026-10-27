import type { AgentConnectionProduct } from "@merakcode/sdk/client"
import { Route, Router } from "@solidjs/router"
import { render } from "solid-js/web"
import { afterEach, expect, test, vi } from "vitest"
import { setLocale } from "../../i18n"
import { connectionDefaults } from "../conversation/product.fixture"
import { AgentConnections } from "./agent-connections"
import { refreshConnections } from "../../state/agent-connections"

const transport = vi.hoisted(() => ({
  products: [] as AgentConnectionProduct[],
  readGate: undefined as Promise<void> | undefined,
  changeGate: undefined as Promise<void> | undefined,
  reads: 0,
  changes: 0,
  changeResponses: 0,
}))
vi.mock("undici", () => ({
  Agent: class {},
  fetch: async (_url: string, init?: { method?: string; body?: ArrayBuffer }) => {
    if (init?.method === "POST") {
      transport.changes++
      const change = JSON.parse(new TextDecoder().decode(init.body))
      transport.products = transport.products.map((product) =>
        product.id === change.id ? { ...product, enabled: change.enabled, revision: product.revision + 1 } : product,
      )
    }
    const body = structuredClone(transport.products)
    if (init?.method === "POST") {
      await transport.changeGate
      transport.changeResponses++
    }
    if (init?.method !== "POST") {
      transport.reads++
      await transport.readGate
    }
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
  },
}))

let cleanup = () => {}
afterEach(() => {
  cleanup()
  window.history.replaceState({}, "", "/")
})

test.each(["refresh", "change"] as const)("an older %s response cannot undo newer product settings", async (older) => {
  setLocale("zh")
  transport.readGate = undefined
  transport.changeGate = undefined
  transport.reads = 0
  transport.changes = 0
  transport.changeResponses = 0
  transport.products = [
    {
      id: "claude",
      title: "Claude Code",
      connected: true,
      enabled: true,
      builtin: true,
      source: "global",
      ...connectionDefaults,
      revision: 1,
    },
  ]
  await refreshConnections()
  const oldRefresh = Promise.withResolvers<void>()
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <Router>
        <Route path="/" component={AgentConnections} />
      </Router>
    ),
    host,
  )
  cleanup = () => {
    oldRefresh.resolve()
    dispose()
    host.remove()
  }
  const toggle = () => host.querySelector<HTMLButtonElement>('[role="switch"]')!
  const button = (label: string) => [...host.querySelectorAll("button")].find((item) => item.textContent === label)
  await vi.waitFor(() => expect(toggle()?.getAttribute("aria-checked")).toBe("true"))
  if (older === "refresh") {
    transport.readGate = oldRefresh.promise
    button("重新检测")!.click()
    await vi.waitFor(() => expect(transport.reads).toBe(2))
    toggle().click()
    await vi.waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("false"))
    oldRefresh.resolve()
    await vi.waitFor(() => expect(button("重新检测")).toBeDefined())
    expect(toggle().getAttribute("aria-checked")).toBe("false")
  }
  if (older === "change") {
    transport.changeGate = oldRefresh.promise
    toggle().click()
    await vi.waitFor(() => expect(transport.changes).toBe(1))
    transport.products = transport.products.map((product) => ({ ...product, enabled: true, revision: 3 }))
    button("重新检测")!.click()
    await vi.waitFor(() => expect(transport.reads).toBe(2))
    await vi.waitFor(() => expect(button("重新检测")).toBeDefined())
    oldRefresh.resolve()
    await vi.waitFor(() => expect(transport.changeResponses).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(toggle().getAttribute("aria-checked")).toBe("true")
  }
})
