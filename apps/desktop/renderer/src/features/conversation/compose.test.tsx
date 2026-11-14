import { Route, Router, useParams } from "@solidjs/router"
import { render } from "solid-js/web"
import { afterEach, expect, test, vi } from "vitest"
import { setLocale } from "../../i18n"
import { decodeDir, sessionPath } from "../../lib/route"
import { setState } from "../../state/store"
import { Compose } from "./compose"

const requests = vi.hoisted(() => [] as { url: string; method: string }[])
const opened = vi.hoisted(() => ({ directory: undefined as string | undefined }))
const creating = vi.hoisted(() => ({
  gate: undefined as PromiseWithResolvers<Response> | undefined,
}))
vi.mock("../shell/sidebar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shell/sidebar")>()
  return {
    ...actual,
    pickFolder: async (navigate: (path: string) => void) => {
      if (!opened.directory) return
      const { setState } = await import("../../state/store")
      const { sessionPath } = await import("../../lib/route")
      setState("folders", (list) =>
        list.some((folder) => folder.directory === opened.directory)
          ? list
          : [{ directory: opened.directory! }, ...list],
      )
      navigate(sessionPath(opened.directory))
    },
  }
})
vi.mock("undici", () => ({
  Agent: class {},
  fetch: async (url: string, init?: { method?: string }) => {
    requests.push({ url: String(url), method: init?.method ?? "GET" })
    const method = init?.method ?? "GET"
    if (method === "POST" && String(url).endsWith("/session") && creating.gate) return creating.gate.promise
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
  cleanup = () => {}
  setState("folders", [])
  opened.directory = undefined
  if (creating.gate) {
    creating.gate.resolve(new Response("{}", { status: 500 }))
    creating.gate = undefined
  }
  window.history.replaceState({}, "", "/")
  requests.length = 0
})

function mountCompose(directory: string) {
  setLocale("zh")
  window.history.replaceState({}, "", sessionPath(directory))
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <Router>
        <Route
          path="/:dir/session/:id?"
          component={() => {
            const params = useParams()
            return <Compose directory={decodeDir(params.dir ?? "") ?? directory} />
          }}
        />
        <Route path="/" component={() => <Compose directory={directory} />} />
      </Router>
    ),
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
  return host
}

test("a new conversation selects its product without creating a session", async () => {
  const host = mountCompose("/target-selection")
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

test("a new conversation switches workspace among open projects without creating a session", async () => {
  setState("folders", [{ directory: "/workspace-alpha" }, { directory: "/workspace-beta" }])
  const host = mountCompose("/workspace-alpha")
  await vi.waitFor(() => expect(host.querySelector('button[aria-label="工作区"]')).not.toBeNull())
  const picker = host.querySelector<HTMLButtonElement>('button[aria-label="工作区"]')!
  expect(picker.textContent).toContain("workspace-alpha")
  picker.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, pointerType: "mouse" }))
  const beta = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
    option.textContent?.includes("workspace-beta"),
  )!
  expect(beta).toBeDefined()
  beta.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true, pointerType: "mouse" }))
  beta.click()
  await vi.waitFor(() => expect(window.location.pathname).toBe(sessionPath("/workspace-beta")))
  await vi.waitFor(() => expect(picker.textContent).toContain("workspace-beta"))
  expect(requests.filter((request) => request.method === "POST" && request.url.endsWith("/session"))).toEqual([])
})

test("a new conversation opens another project from the workspace picker without creating a session", async () => {
  setState("folders", [{ directory: "/workspace-alpha" }])
  opened.directory = "/workspace-gamma"
  const host = mountCompose("/workspace-alpha")
  await vi.waitFor(() => expect(host.querySelector('button[aria-label="工作区"]')).not.toBeNull())
  const picker = host.querySelector<HTMLButtonElement>('button[aria-label="工作区"]')!
  picker.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, pointerType: "mouse" }))
  const open = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
    option.textContent?.includes("打开项目"),
  )!
  expect(open).toBeDefined()
  open.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true, pointerType: "mouse" }))
  open.click()
  await vi.waitFor(() => expect(window.location.pathname).toBe(sessionPath("/workspace-gamma")))
  expect(requests.filter((request) => request.method === "POST" && request.url.endsWith("/session"))).toEqual([])
})

test("the workspace picker stays disabled while a new conversation is being created", async () => {
  creating.gate = Promise.withResolvers()
  setState("folders", [{ directory: "/workspace-busy" }])
  const host = mountCompose("/workspace-busy")
  await vi.waitFor(() => expect(host.querySelector('button[aria-label="工作区"]')).not.toBeNull())
  const picker = host.querySelector<HTMLButtonElement>('button[aria-label="工作区"]')!
  expect(picker.disabled).toBe(false)
  const input = host.querySelector<HTMLTextAreaElement>("textarea[aria-label]")!
  input.value = "start"
  input.dispatchEvent(new InputEvent("input", { bubbles: true }))
  host.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!.click()
  await vi.waitFor(() => expect(picker.disabled).toBe(true))
})

test("the new-conversation context controls share one outlined chip style", async () => {
  setState("folders", [
    {
      directory: "/workspace-styled",
      project: {
        id: "styled",
        worktree: "/workspace-styled",
        sandboxes: [],
        vcs: "git",
        time: { created: 1, updated: 1 },
      },
    },
  ])
  setState("branch", "/workspace-styled", "main")
  const host = mountCompose("/workspace-styled")
  await vi.waitFor(() => expect(host.querySelector('button[aria-label="新工作树"]')).not.toBeNull())
  const branch = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    (button.getAttribute("aria-label") ?? "").startsWith("当前分支"),
  )
  const controls = [
    host.querySelector<HTMLButtonElement>('button[aria-label="对话对象"]'),
    host.querySelector<HTMLButtonElement>('button[aria-label="工作区"]'),
    branch,
    host.querySelector<HTMLButtonElement>('button[aria-label="新工作树"]'),
  ]
  for (const control of controls) {
    expect(control).toBeTruthy()
    expect(control!.classList.contains("chip")).toBe(true)
    expect(control!.classList.contains("outlined")).toBe(true)
  }
})
