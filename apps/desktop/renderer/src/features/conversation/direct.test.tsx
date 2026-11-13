import { execFileSync } from "node:child_process"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Route, Router } from "@solidjs/router"
import { render } from "solid-js/web"
import { afterAll, afterEach, beforeAll, expect, test } from "vitest"
import type { AgentAgent } from "@merakcode/sdk"
import { setLocale, t } from "../../i18n"
import { saveAgent } from "../../state/agents"
import { client } from "../../state/client"
import { connect, loadProviders, setState } from "../../state/store"
import { engineFixture } from "../../test/engine"
import { Toasts } from "../../ui/toast"
import { AgentsPage } from "../agents/agents"
import { Compose } from "./compose"
import { Conversation } from "./page"

let engine: Awaited<ReturnType<typeof engineFixture>>
let stop = () => {}
const originalPath = process.env.PATH
beforeAll(async () => {
  // A stand-in for the claude command that answers every message with the message itself
  const bin = await mkdtemp(path.join(tmpdir(), "merak-direct-bin-"))
  execFileSync(
    "go",
    [
      "build",
      "-o",
      path.join(bin, process.platform === "win32" ? "claude.exe" : "claude"),
      "./engine/worker/claudecode/testdata/fakeclaude",
    ],
    { cwd: path.resolve(import.meta.dirname, "../../../../../../merak"), windowsHide: true },
  )
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`
  engine = await engineFixture()
  location.href = engine.url
  stop = connect()
  await client()
  await loadProviders()
  setLocale("zh")
}, 120000)
afterAll(async () => {
  stop()
  process.env.PATH = originalPath
  await engine.close()
})
let cleanup = () => {}
afterEach(() => {
  cleanup()
  cleanup = () => {}
  document.querySelectorAll('[role="dialog"]').forEach((dialog) => dialog.closest(".dialog-positioner")?.remove())
  setState("folders", [])
  window.history.replaceState({}, "", "/")
})

const external = (name: string, extra: Partial<AgentAgent> = {}): AgentAgent => ({
  id: "",
  name,
  role: "worker",
  summary: "",
  duties: "",
  toolPool: "worker.default",
  shared: true,
  model: { provider: "", model: "" },
  product: { kind: "claude-code", binary: "claude", args: ["--echo"] },
  ...extra,
})

function mount(view: () => import("solid-js").JSX.Element, path = "/") {
  window.history.replaceState({}, "", path)
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <Router
        root={(props) => (
          <>
            {props.children}
            <Toasts />
          </>
        )}
      >
        <Route path="*" component={view} />
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

test("an agent with a product has a switch on the Agents page that saves it as turned off and on again", async () => {
  const connection = await client()
  const saved = await connection.agent.save({ agent: external("Switchable CLI") })
  expect(saved.disabled).toBeFalsy()
  const host = mount(() => <AgentsPage />, "/agents")
  const name = t("agents.enable", { name: "Switchable CLI" })
  const toggle = () => host.querySelector<HTMLButtonElement>(`button[role="switch"]`)
  await expect.poll(toggle, { timeout: 10000 }).not.toBeNull()
  expect(toggle()!.textContent).toBe(name)
  expect(toggle()!.getAttribute("aria-checked")).toBe("true")
  const disabled = async () =>
    (await connection.agent.list({}))!.find((agent) => agent.id === saved.id)?.disabled ?? false
  toggle()!.click()
  await expect.poll(disabled, { timeout: 10000 }).toBe(true)
  await expect.poll(() => toggle()!.getAttribute("aria-checked")).toBe("false")
  toggle()!.click()
  await expect.poll(disabled, { timeout: 10000 }).toBe(false)
  await expect.poll(() => toggle()!.getAttribute("aria-checked")).toBe("true")
}, 60000)

const poll = (check: () => unknown, timeout = 10000) => expect.poll(check, { timeout })
const open = (trigger: HTMLElement) =>
  trigger.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, pointerType: "mouse" }))
const type = (host: ParentNode, value: string) => {
  const input = host.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${t("prompt.label")}"]`)!
  input.value = value
  input.dispatchEvent(new InputEvent("input", { bubbles: true }))
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
}

test("the new-chat page offers MerakCode and the agents with a product that are turned on, and a first message starts the external conversation", async () => {
  const connection = await client()
  const direct = await connection.agent.save({ agent: external("Direct CLI") })
  await connection.agent.save({ agent: external("Off CLI", { disabled: true }) })
  const host = mount(() => <Compose directory={engine.project} />)
  const target = t("conversation.target")
  await poll(() => host.querySelector(`button[aria-label="${target}"]`)).not.toBeNull()
  expect(host.querySelector(`button[aria-label="${target}"]`)!.textContent).toContain("MerakCode")
  open(host.querySelector<HTMLElement>(`button[aria-label="${target}"]`)!)
  const labelsNow = () => [...document.querySelectorAll('[role="option"]')].map((item) => item.textContent)
  await poll(labelsNow).toContain("Direct CLI")
  const labels = labelsNow()
  expect(labels).toContain("MerakCode")
  expect(labels).toContain("Direct CLI")
  expect(labels).not.toContain("Off CLI")
  ;[...document.querySelectorAll<HTMLElement>('[role="option"]')]
    .find((item) => item.textContent === "Direct CLI")!
    .click()
  await poll(() => host.querySelector(`button[aria-label="${target}"]`)!.textContent).toContain("Direct CLI")
  type(host, "first direct message")
  await poll(async () => (await connection.session.list({}))?.length).toBe(1)
  const created = (await connection.session.list({}))![0]!
  expect(created.config.workdir).toBe(engine.project)
  expect((await connection.session.external({ session: created.id })).agent).toBe(direct.id)
  await poll(async () =>
    JSON.stringify(await connection.events.find({ scope: { session: created.id }, types: ["message.completed"] })),
  ).toContain("External reply: first direct message")
}, 60000)

const dialogs = () => document.querySelectorAll('[role="dialog"]:not([data-closed])')
const dialogButton = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (item) => item.textContent?.trim() === label,
  )
const input = (host: ParentNode) =>
  host.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${t("prompt.label")}"]`)!

/** A conversation with an external agent that has answered once. */
async function answered(name: string) {
  const connection = await client()
  const agent = await connection.agent.save({ agent: external(name) })
  const created = await connection.session.create({ agent: agent.id, workdir: engine.project })
  await connection.session.send({ session: created.session, parts: [{ text: "history message" }] })
  await poll(async () =>
    JSON.stringify(await connection.events.find({ scope: { session: created.session }, types: ["message.completed"] })),
  ).toContain("External reply: history message")
  return { agent, session: created.session, connection }
}

test("a conversation with an agent that is turned off is locked, asks about a takeover once and unlocks when the agent is on again", async () => {
  const { agent, session } = await answered("Lockable CLI")
  const show = () => mount(() => <Conversation id={session} directory={engine.project} />)
  let host = show()
  await poll(() => input(host)).not.toBeNull()
  await poll(() => host.textContent).toContain("External reply: history message")
  expect(input(host).disabled).toBe(false)
  expect(dialogs().length).toBe(0)
  await saveAgent({ ...agent, disabled: true })
  await poll(() => dialogs().length).toBe(1)
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain(t("conversation.takeover.title"))
  expect(input(host).disabled).toBe(true)
  expect(host.textContent).toContain(t("conversation.takeover.blocked"))
  dialogButton(t("conversation.takeover.decline"))!.click()
  await poll(() => dialogs().length).toBe(0)
  cleanup()
  host = show()
  await poll(() => host.textContent).toContain(t("conversation.takeover.blocked"))
  expect(input(host).disabled).toBe(true)
  expect(dialogs().length).toBe(0)
  await saveAgent({ ...agent, disabled: false })
  await poll(() => input(host).disabled).toBe(false)
  expect(host.textContent).not.toContain(t("conversation.takeover.blocked"))
  await saveAgent({ ...agent, disabled: true })
  await poll(() => dialogs().length).toBe(1)
}, 60000)

test("accepting a takeover turns the conversation into one of MerakCode that keeps the history and answers with the model", async () => {
  const { agent, session, connection } = await answered("Handover CLI")
  setState("connected", true)
  setState("config", { providers: { fake: { hasKey: true } } })
  setState("models", [
    {
      provider: "fake",
      id: "fixture",
      window: 32000,
      maxOutput: 2048,
      source: "builtin",
      thinking: [],
      caps: { tools: true, vision: false, pdf: false },
      price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ])
  const host = mount(() => <Conversation id={session} directory={engine.project} />)
  await poll(() => host.textContent).toContain("External reply: history message")
  await saveAgent({ ...agent, disabled: true })
  await poll(() => dialogs().length).toBe(1)
  dialogButton(t("conversation.takeover.accept"))!.click()
  await poll(() => host.textContent).toContain(t("conversation.takeover.completed"))
  expect(dialogs().length).toBe(0)
  expect((await connection.session.external({ session })).agent ?? "").toBe("")
  expect(host.textContent).toContain("External reply: history message")
  await poll(() => input(host).disabled).toBe(false)
  input(host).value = "continue with MerakCode"
  input(host).dispatchEvent(new InputEvent("input", { bubbles: true }))
  input(host).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  await poll(() => host.textContent).toContain("Feedback received")
  expect(host.textContent).toContain("External reply: history message")
}, 60000)
