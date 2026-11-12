import { execFileSync } from "node:child_process"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Route, Router } from "@solidjs/router"
import { render } from "solid-js/web"
import { afterAll, afterEach, beforeAll, expect, test } from "vitest"
import { setLocale, t } from "../../i18n"
import { client } from "../../state/client"
import { localHuman } from "../../state/groups"
import { connect, loadProviders, setState } from "../../state/store"
import { engineFixture } from "../../test/engine"
import { Toasts } from "../../ui/toast"
import { AgentsPage } from "./agents"

let engine: Awaited<ReturnType<typeof engineFixture>>
let stop = () => {}
const originalPath = process.env.PATH
beforeAll(async () => {
  // A stand-in for the claude command on this machine, so the product list has something to detect
  const bin = await mkdtemp(path.join(tmpdir(), "merak-agents-bin-"))
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

function show(search = "") {
  setLocale("zh")
  window.history.replaceState({}, "", `/agents${search}`)
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
        <Route path="/agents" component={AgentsPage} />
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

const button = (root: ParentNode, label: string) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
  )
const mine = (host: HTMLElement) => host.querySelector<HTMLElement>(`[aria-label="${t("agents.mine")}"]`)!
const detected = (host: HTMLElement) => host.querySelector<HTMLElement>(`[aria-label="${t("agents.detected")}"]`)!
const click = async (root: ParentNode, label: string) => {
  await expect.poll(() => button(root, label), { message: label, timeout: 10000 }).toBeDefined()
  button(root, label)!.click()
}
const productAgents = async () =>
  ((await (await client()).agent.list({})) ?? []).filter((agent) => agent.product?.kind === "claude-code")

test("a detected product is added in one click, once, and the button then says it is added", async () => {
  const host = show()
  const add = t("agents.addProduct", { name: "Claude Code" })
  await expect.poll(() => button(detected(host), add), { timeout: 20000 }).toBeDefined()
  expect(detected(host).textContent).toContain("2.1.0 (Claude Code fixture)")
  expect(await productAgents()).toHaveLength(0)
  button(detected(host), add)!.click()
  await expect.poll(async () => (await productAgents()).length, { timeout: 10000 }).toBe(1)
  await expect.poll(() => mine(host).textContent, { timeout: 10000 }).toContain("Claude Code")
  await expect.poll(() => button(detected(host), t("agents.added", { name: "Claude Code" }))).toBeDefined()
  const done = button(detected(host), t("agents.added", { name: "Claude Code" }))!
  expect(done.disabled).toBe(true)
  done.click()
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(await productAgents()).toHaveLength(1)
  expect(button(detected(host), add)).toBeUndefined()
}, 60000)

test("the wizard picks the model with the conversation's model picker for MerakCode and asks for a command, arguments and secrets for a product", async () => {
  setState("config", { providers: { fake: { hasKey: true } } })
  setState("models", [
    {
      provider: "fake",
      id: "fixture",
      window: 32000,
      maxOutput: 4096,
      source: "builtin",
      thinking: [],
      caps: { tools: true, vision: false, pdf: false },
      price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ])
  const host = show("?new=1")
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]:not([data-closed])')!
  await expect
    .poll(() => document.querySelector('[role="dialog"]:not([data-closed])'), { timeout: 10000 })
    .not.toBeNull()
  // Step one: the role and the product; MerakCode is the first choice
  expect(dialog().querySelector('[role="radio"][aria-checked="true"]')).not.toBeNull()
  await click(dialog(), t("agents.step.next"))
  await expect
    .poll(() => dialog().querySelector(`button[aria-label^="${t("model.named", { name: "" })}"]`), { timeout: 10000 })
    .not.toBeNull()
  expect(dialog().querySelector(`input[aria-label="${t("settings.collaboration.command")}"]`)).toBeNull()
  await click(dialog(), t("agents.step.back"))
  const radio = (label: string) =>
    [...dialog().querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((item) =>
      item.textContent?.includes(label),
    )
  await expect.poll(() => radio("Claude Code"), { timeout: 20000 }).toBeDefined()
  radio("Claude Code")!.click()
  await click(dialog(), t("agents.step.next"))
  const command = () =>
    dialog().querySelector<HTMLInputElement>(`input[aria-label="${t("settings.collaboration.command")}"]`)
  await expect.poll(command).not.toBeNull()
  expect(command()!.value).not.toBe("")
  expect(dialog().querySelector(`button[aria-label^="${t("model.named", { name: "" })}"]`)).toBeNull()
  expect(dialog().querySelector(`textarea[aria-label="${t("settings.collaboration.args")}"]`)).not.toBeNull()
  await click(dialog(), t("agents.env.add"))
  const value = dialog().querySelector<HTMLInputElement>(`input[aria-label="${t("agents.env.value")}"]`)!
  expect(value.type).toBe("password")
  expect(host).toBeDefined()
}, 60000)

test("a saved secret shows that it is kept and an empty field leaves it unchanged", async () => {
  const connection = await client()
  const saved = await connection.agent.save({
    agent: {
      id: "",
      name: "Secret keeper",
      role: "worker",
      summary: "",
      duties: "",
      toolPool: "worker.default",
      model: { provider: "", model: "" },
      product: { kind: "command", binary: "echo", env: { MERAK_TOKEN: "s3cret" } },
    },
  })
  expect(saved.product?.env).toEqual({ MERAK_TOKEN: "" })
  const host = show()
  await expect
    .poll(() => button(mine(host), t("agents.edit", { name: "Secret keeper" })), { timeout: 10000 })
    .toBeDefined()
  button(mine(host), t("agents.edit", { name: "Secret keeper" }))!.click()
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]:not([data-closed])')!
  await expect.poll(() => document.querySelector('[role="dialog"]:not([data-closed])')).not.toBeNull()
  await click(dialog(), t("agents.step.next"))
  const value = () => dialog().querySelector<HTMLInputElement>(`input[aria-label="${t("agents.env.value")}"]`)!
  await expect.poll(value).not.toBeNull()
  expect(value().type).toBe("password")
  expect(value().value).toBe("")
  expect(value().placeholder).toBe(t("agents.env.saved"))
  await click(dialog(), t("agents.step.next"))
  await click(dialog(), t("agents.step.next"))
  await click(dialog(), t("agents.save"))
  await expect.poll(() => document.querySelector('[role="dialog"]:not([data-closed])'), { timeout: 10000 }).toBeNull()
  const after = (await connection.agent.list({}))!.find((agent) => agent.id === saved.id)!
  expect(after.product?.env).toEqual({ MERAK_TOKEN: "" })
  expect(after.name).toBe("Secret keeper")
}, 60000)

test("deleting an agent that is still in a group shows the engine's reason and leaves the list as it was", async () => {
  const connection = await client()
  const agent = await connection.agent.save({
    agent: {
      id: "",
      name: "Busy writer",
      role: "worker",
      summary: "",
      duties: "",
      toolPool: "worker.default",
      model: { provider: "fake", model: "fixture" },
    },
  })
  await engine.git("commit", "--allow-empty", "-m", "Fixture")
  await connection.group.create({
    id: "",
    kind: "local",
    name: "Keeps agents",
    project: { directory: engine.project },
    leader: "leader",
    members: [
      { id: localHuman, group: "", kind: "human", name: "You", role: "owner", status: "idle" },
      {
        id: "leader",
        group: "",
        kind: "agent",
        name: "Lead",
        agentRole: "leader",
        agent: "builtin-leader",
        status: "idle",
      },
      {
        id: "writer",
        group: "",
        kind: "agent",
        name: "Busy writer",
        agentRole: "worker",
        agent: agent.id,
        status: "idle",
      },
    ],
  })
  const host = show()
  await expect
    .poll(() => button(mine(host), t("agents.delete", { name: "Busy writer" })), { timeout: 10000 })
    .toBeDefined()
  const before = mine(host).querySelectorAll("article").length
  button(mine(host), t("agents.delete", { name: "Busy writer" }))!.click()
  await click(document, t("agents.deleteConfirm"))
  await expect
    .poll(() => document.querySelector(".toast")?.textContent, { timeout: 10000 })
    .toContain("智能体还在协作群里")
  expect(document.querySelector(".toast")?.textContent).toContain("先把它从所有协作群里移除，再删除。")
  expect(document.querySelector(".toast")?.textContent).toContain("MRK-6004")
  expect(mine(host).querySelectorAll("article")).toHaveLength(before)
  expect((await connection.agent.list({}))!.some((item) => item.id === agent.id)).toBe(true)
}, 60000)

test("the wizard saves a product with its arguments, model, secrets and network hosts after a real connection check", async () => {
  const host = show("?new=1")
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]:not([data-closed])')!
  await expect
    .poll(() => document.querySelector('[role="dialog"]:not([data-closed])'), { timeout: 10000 })
    .not.toBeNull()
  const radio = (label: string) =>
    [...dialog().querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((item) =>
      item.textContent?.includes(label),
    )
  await expect.poll(() => radio("Claude Code"), { timeout: 20000 }).toBeDefined()
  radio("Claude Code")!.click()
  await click(dialog(), t("agents.step.next"))
  const field = (label: string) =>
    dialog().querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!
  const type = (label: string, value: string) => {
    field(label).value = value
    field(label).dispatchEvent(new InputEvent("input", { bubbles: true }))
  }
  await expect.poll(() => field(t("settings.collaboration.command"))?.value, { timeout: 10000 }).not.toBe("")
  const binary = field(t("settings.collaboration.command")).value
  type(t("settings.collaboration.args"), "--history")
  type(t("agents.productModel"), "fixture-model")
  await click(dialog(), t("agents.env.add"))
  type(t("agents.env.name"), "FIXTURE_VALUE")
  type(t("agents.env.value"), "example")
  await click(dialog(), t("agents.testShort"))
  await expect.poll(() => dialog().textContent, { timeout: 30000 }).toContain(t("agents.tested"))
  await click(dialog(), t("agents.step.next"))
  type(t("agents.name"), "CLI tester")
  await click(dialog(), t("agents.step.next"))
  type(t("agents.network"), "api.example.com\n*.models.example.com:443")
  await click(dialog(), t("agents.save"))
  await expect.poll(() => document.querySelector('[role="dialog"]:not([data-closed])'), { timeout: 10000 }).toBeNull()
  const saved = (await (await client()).agent.list({}))!.find((agent) => agent.name === "CLI tester")!
  expect(saved.product).toEqual({
    kind: "claude-code",
    binary,
    args: ["--history"],
    model: "fixture-model",
    env: { FIXTURE_VALUE: "" },
  })
  expect(saved.network).toEqual(["api.example.com", "*.models.example.com:443"])
  expect(saved.role).toBe("worker")
  expect(mine(host).textContent).toContain("CLI tester")
}, 90000)

test("copying a built-in agent opens the wizard with its duties, and a full takeover needs an explicit confirmation", async () => {
  const host = show()
  await expect.poll(() => button(mine(host), t("agents.copy", { name: "Worker" })), { timeout: 10000 }).toBeDefined()
  button(mine(host), t("agents.copy", { name: "Worker" }))!.click()
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]:not([data-closed])')!
  await expect.poll(() => document.querySelector('[role="dialog"]:not([data-closed])')).not.toBeNull()
  await click(dialog(), t("agents.step.next"))
  await click(dialog(), t("agents.step.next"))
  const name = dialog().querySelector<HTMLInputElement>(`input[aria-label="${t("agents.name")}"]`)!
  expect(name.value).toBe(t("agents.copyName", { name: "Worker" }))
  name.value = "Audit"
  name.dispatchEvent(new InputEvent("input", { bubbles: true }))
  const duties = dialog().querySelector<HTMLTextAreaElement>(`textarea[aria-label="${t("agents.duties")}"]`)!
  duties.value = "Review Go changes and verify regression tests."
  duties.dispatchEvent(new InputEvent("input", { bubbles: true }))
  await click(dialog(), t("agents.step.next"))
  dialog()
    .querySelector<HTMLButtonElement>(`button[aria-label="${t("permissionLevel.label")}"]`)!
    .dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, pointerType: "mouse" }))
  await expect.poll(() => document.querySelectorAll('[role="option"]').length).toBeGreaterThan(0)
  ;[...document.querySelectorAll<HTMLElement>('[role="option"]')]
    .find((option) => option.textContent?.includes(t("permissionLevel.fullTakeover")))!
    .click()
  await click(
    [...document.querySelectorAll<HTMLElement>('[role="dialog"]:not([data-closed])')].at(-1)!,
    t("permissionLevel.confirm.accept"),
  )
  await click(dialog(), t("agents.save"))
  await expect
    .poll(async () => (await (await client()).agent.list({}))!.find((agent) => agent.name === "Audit")?.mode, {
      timeout: 10000,
    })
    .toBe("takeover")
  expect((await (await client()).agent.list({}))!.find((agent) => agent.name === "Audit")?.duties).toBe(
    "Review Go changes and verify regression tests.",
  )
}, 60000)

test("each agent in the list shows its harness, model, name and duties, and the wizard edits all of them", async () => {
  const connection = await client()
  const saved = await connection.agent.save({
    agent: {
      id: "",
      name: "Planner",
      role: "worker",
      summary: "Plans the work",
      duties: "Break features into small steps.",
      toolPool: "worker.default",
      model: { provider: "fake", model: "fixture" },
    },
  })
  const external = await connection.agent.save({
    agent: {
      id: "",
      name: "Shell helper",
      role: "worker",
      summary: "",
      duties: "Run commands.",
      toolPool: "worker.default",
      model: { provider: "", model: "" },
      product: { kind: "command", binary: "echo", model: "small-one" },
    },
  })
  const host = show()
  const card = (id: string) => host.querySelector<HTMLElement>(`[data-agent="${id}"]`)
  await expect.poll(() => card(saved.id), { timeout: 10000 }).not.toBeNull()
  expect(card(saved.id)!.querySelector("[data-harness]")?.textContent).toBe("MerakCode")
  expect(card(saved.id)!.querySelector("[data-model]")?.textContent).toBe("fake/fixture")
  expect(card(saved.id)!.textContent).toContain("Planner")
  expect(card(saved.id)!.querySelector("[data-duties]")?.textContent).toBe("Break features into small steps.")
  expect(card(external.id)!.querySelector("[data-harness]")?.textContent).toBe("command")
  expect(card(external.id)!.querySelector("[data-model]")?.textContent).toBe("small-one")
  button(card(saved.id)!, t("agents.edit", { name: "Planner" }))!.click()
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]:not([data-closed])')!
  await expect.poll(() => document.querySelector('[role="dialog"]:not([data-closed])')).not.toBeNull()
  await click(dialog(), t("agents.step.next"))
  expect(
    dialog()
      .querySelector(`button[aria-label^="${t("model.named", { name: "" })}"]`)
      ?.getAttribute("aria-label"),
  ).toContain("fixture")
  await click(dialog(), t("agents.step.next"))
  const type = (label: string, value: string) => {
    const field = dialog().querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!
    field.value = value
    field.dispatchEvent(new InputEvent("input", { bubbles: true }))
  }
  type(t("agents.name"), "Architect")
  type(t("agents.summary"), "Designs the work")
  type(t("agents.duties"), "Design first, then split.")
  await click(dialog(), t("agents.step.next"))
  await click(dialog(), t("agents.save"))
  await expect
    .poll(async () => (await connection.agent.list({}))!.find((agent) => agent.id === saved.id)?.name, {
      timeout: 10000,
    })
    .toBe("Architect")
  const after = (await connection.agent.list({}))!.find((agent) => agent.id === saved.id)!
  expect(after).toMatchObject({
    summary: "Designs the work",
    duties: "Design first, then split.",
    model: { provider: "fake", model: "fixture" },
  })
  await expect
    .poll(() => card(saved.id)?.querySelector("[data-duties]")?.textContent, { timeout: 10000 })
    .toBe("Design first, then split.")
}, 60000)
