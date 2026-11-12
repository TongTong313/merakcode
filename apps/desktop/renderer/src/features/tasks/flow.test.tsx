import { Route, Router } from "@solidjs/router"
import { render } from "solid-js/web"
import { afterAll, afterEach, beforeAll, expect, test } from "vitest"
import { EngineEventSchema, type TaskCard } from "@merakcode/sdk"
import { setLocale, t } from "../../i18n"
import { client } from "../../state/client"
import { connectGroups, loadGroups, localHuman } from "../../state/groups"
import { connect } from "../../state/store"
import { connectTasks, loadTasks } from "../../state/tasks"
import { engineFixture } from "../../test/engine"
import { TaskCreate } from "./create"
import { TaskPage } from "./page"

let engine: Awaited<ReturnType<typeof engineFixture>>
let stop = () => {}
beforeAll(async () => {
  engine = await engineFixture()
  location.href = engine.url
  await engine.git("commit", "--allow-empty", "-m", "Fixture")
  setLocale("en")
  const stopStore = connect()
  const stopGroups = connectGroups()
  const stopTasks = connectTasks()
  stop = () => {
    stopTasks()
    stopGroups()
    stopStore()
  }
  await client()
})
afterAll(async () => {
  stop()
  await engine.close()
})
let cleanup = () => {}
afterEach(() => {
  cleanup()
  cleanup = () => {}
  document.querySelectorAll(".dialog-positioner").forEach((node) => node.remove())
  window.history.replaceState({}, "", "/")
})

const open = () => document.querySelector<HTMLElement>('[role="dialog"]:not([data-closed])')!
const find = (root: ParentNode, label: string) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
  )
const click = async (root: ParentNode, label: string) => {
  await expect.poll(() => find(root, label), { message: label, timeout: 10000 }).toBeDefined()
  find(root, label)!.click()
}
const fill = (label: string, value: string) => {
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[role="dialog"] [aria-label="${label}"]`,
  )!
  input.value = value
  input.dispatchEvent(new InputEvent("input", { bubbles: true }))
}

function showTask(id: string) {
  window.history.replaceState({}, "", `/task/${id}`)
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <Router>
        <Route path="/task/:id" component={TaskPage} />
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

test("a task is created with a workspace, a title, a description, acceptance criteria and a review, and belongs to no group", async () => {
  const connection = await client()
  let created: TaskCard | undefined
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => <TaskCreate directory={engine.project} open onClose={() => {}} onCreated={(card) => (created = card)} />,
    host,
  )
  cleanup = () => {
    dispose()
    host.remove()
  }
  await expect.poll(open, { timeout: 10000 }).not.toBeNull()
  expect(open().querySelector<HTMLButtonElement>('button[aria-label="Workspace"]')!.disabled).toBe(false)
  expect(find(open(), t("taskCreate.submit"))!.disabled).toBe(true)
  fill(t("task.title"), "Update the guide")
  fill(t("task.description"), "Document the new behavior.")
  fill(t("task.acceptance"), "Examples pass\nLinks work")
  await expect.poll(() => find(open(), t("taskCreate.submit"))!.disabled).toBe(false)
  find(open(), t("taskCreate.submit"))!.click()
  await expect.poll(() => created, { timeout: 10000 }).toBeDefined()
  const facts = await connection.events.find({ scope: { task: created!.id }, types: ["task.created"] })
  const event = EngineEventSchema.parse(facts![0])
  if (event.type !== "task.created") throw new Error("Task creation event is missing")
  expect(event.payload).toMatchObject({
    title: "Update the guide",
    description: "Document the new behavior.",
    acceptance: ["Examples pass", "Links work"],
    review: true,
    createdBy: { id: localHuman, kind: "human" },
  })
  expect(event.payload.group).toBeFalsy()
  expect(event.payload.project).toBe(engine.project)
})

test("a task in a group is assigned from its page, and its worker's report and process show there", async () => {
  const connection = await client()
  const agents = (await connection.agent.list({}))!
  const [lead, worker] = await Promise.all(
    [agents[0]!, agents[1]!].map((agent, index) =>
      connection.agent.save({
        agent: { ...agent, id: "", name: index ? "Writer" : "Chief", model: { provider: "fake", model: "fixture" } },
      }),
    ),
  )
  const group = await connection.group.create({
    id: "",
    kind: "local",
    name: "Delivery",
    project: { directory: engine.project },
    leader: "leader",
    members: [
      { id: localHuman, group: "", kind: "human", name: "You", role: "owner", status: "idle" },
      {
        id: "leader",
        group: "",
        kind: "agent",
        name: "Chief",
        agentRole: "leader",
        agent: lead!.id,
        owner: localHuman,
        status: "idle",
      },
      {
        id: "worker",
        group: "",
        kind: "agent",
        name: "Writer",
        agentRole: "worker",
        agent: worker!.id,
        owner: localHuman,
        status: "idle",
      },
    ],
  })
  await loadGroups()
  const card = await connection.task.create({ group: group.id, title: "Verify guide", review: true })
  await loadTasks()
  const host = showTask(card.id)
  await expect.poll(() => host.textContent, { timeout: 15000 }).toContain("Verify guide")
  const trigger = () => host.querySelector<HTMLButtonElement>(`button[aria-label="${t("task.assign")}"]`)
  await expect.poll(trigger, { timeout: 15000 }).not.toBeNull()
  await expect.poll(() => host.textContent).toContain("Delivery")
  trigger()!.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, pointerType: "mouse" }))
  await expect.poll(() => document.querySelectorAll('[role="option"]').length, { timeout: 10000 }).toBeGreaterThan(0)
  const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
  expect(options.map((option) => option.textContent)).toEqual(["Writer"])
  options[0]!.click()
  const assign = () =>
    [...host.querySelectorAll<HTMLButtonElement>("button")]
      .filter((item) => item.textContent === t("task.assign"))
      .at(-1)!
  await expect.poll(() => assign().disabled).toBe(false)
  assign().click()
  await expect
    .poll(() => host.querySelector('[aria-label="Worker report"]')?.textContent, { timeout: 20000 })
    .toContain("Feedback received")
  expect(host.querySelector("[data-claim]")?.textContent).toContain(t("task.claimGiven", { name: "Writer" }))
  const process = [...host.querySelectorAll("details")].find(
    (element) => element.querySelector("summary")?.textContent === t("task.process"),
  )!
  process.open = true
  process.dispatchEvent(new Event("toggle"))
  await expect
    .poll(() => process.querySelector('[role="log"]')?.textContent, { timeout: 10000 })
    .toContain("Please submit your report with submit_report")
})

test("a task is cancelled from its page", async () => {
  const connection = await client()
  const card = await connection.task.create({ title: "Cancel from the page", project: engine.project })
  await loadTasks()
  const host = showTask(card.id)
  await click(host, t("task.cancel"))
  await expect
    .poll(async () => (await connection.task.list({}))!.find((item) => item.id === card.id)?.status, {
      timeout: 10000,
    })
    .toBe("cancelled")
  await expect.poll(() => find(host, t("task.cancel"))).toBeUndefined()
})
