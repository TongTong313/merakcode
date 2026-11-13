import { Route, Router, useLocation } from "@solidjs/router"
import { render } from "solid-js/web"
import { afterAll, afterEach, beforeAll, expect, test } from "vitest"
import { Home } from "../../app"
import { setLocale, t } from "../../i18n"
import { client } from "../../state/client"
import { connectGroups, loadGroups, localHuman } from "../../state/groups"
import { connect, setState } from "../../state/store"
import { connectTasks } from "../../state/tasks"
import { engineFixture } from "../../test/engine"
import { Toasts } from "../../ui/toast"
import { Notify } from "../shell/notify"

let engine: Awaited<ReturnType<typeof engineFixture>>
let stop = () => {}
beforeAll(async () => {
  engine = await engineFixture({
    replies: [
      {
        role: "worker",
        calls: [{ id: "write", name: "write_file", input: { path: "answer.txt", content: "Approved" } }],
      },
      ...Array.from({ length: 12 }, () => ({ role: "worker", text: "Waiting." })),
      ...Array.from({ length: 40 }, () => ({ role: "leader", text: "Noted." })),
    ],
  })
  await engine.git("commit", "--allow-empty", "-m", "Fixture")
  location.href = engine.url
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
  window.history.replaceState({}, "", "/")
})

function Where() {
  const location = useLocation()
  return <output data-where>{location.pathname + location.search}</output>
}

function show() {
  setLocale("zh")
  setState("folders", [{ directory: engine.project }])
  window.history.replaceState({}, "", "/")
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <Router
        root={(props) => (
          <>
            {props.children}
            <Notify />
            <Where />
            <Toasts />
          </>
        )}
      >
        <Route path="/" component={Home} />
        <Route path="*" component={() => <p>elsewhere</p>} />
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

const rows = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("[data-notice]")]
const where = () => document.querySelector("[data-where]")?.textContent

async function newGroup(name: string) {
  const connection = await client()
  const agents = (await connection.agent.list({}))!
  const [leader, worker] = await Promise.all([
    connection.agent.save({
      agent: { ...agents[0]!, id: "", name: `${name} lead`, model: { provider: "fake", model: "fixture" } },
    }),
    connection.agent.save({
      agent: { ...agents[0]!, id: "", name: `${name} writer`, model: { provider: "fake", model: "fixture" } },
    }),
  ])
  const group = await connection.group.create({
    id: "",
    kind: "local",
    name,
    project: { directory: engine.project },
    leader: "leader",
    members: [
      { id: localHuman, group: "", kind: "human", name: "You", role: "owner", status: "idle" },
      {
        id: "leader",
        group: "",
        kind: "agent",
        name: "Coordinator",
        agentRole: "leader",
        agent: leader.id,
        owner: localHuman,
        status: "idle",
      },
      {
        id: "worker",
        group: "",
        kind: "agent",
        name: "Writer",
        agentRole: "worker",
        agent: worker.id,
        owner: localHuman,
        status: "idle",
      },
    ],
  })
  await loadGroups()
  return group
}

test("the inbox column lists a finished task and a request for approval, newest first, and opens the approval", async () => {
  const connection = await client()
  const group = await newGroup("Decisions")
  const host = show()
  const finished = await connection.task.create({ group: group.id, title: "Tidy the notes" })
  await connection.task.cancel({ task: finished.id })
  await expect
    .poll(() => rows(host).map((row) => row.textContent), { timeout: 15000 })
    .toEqual([expect.stringContaining("Tidy the notes")])
  await connection.task.create({ group: group.id, member: "worker", title: "Write the answer", review: true })
  await expect.poll(() => rows(host).length, { timeout: 20000 }).toBe(2)
  const [first, second] = rows(host)
  expect(first!.getAttribute("data-notice")).toBe("permission")
  expect(first!.textContent).toContain("write_file")
  expect(first!.textContent).toContain("Decisions")
  expect(second!.getAttribute("data-notice")).toBe("info")
  expect(second!.textContent).toContain("Tidy the notes")
  expect(second!.textContent).toContain(t("inbox.taskDone"))
  first!.querySelector<HTMLButtonElement>("button[data-open]")!.click()
  await expect
    .poll(() => document.querySelector(`[role="region"][aria-label="${t("approval.label")}"]`), { timeout: 10000 })
    .not.toBeNull()
}, 60000)

test("a new inbox message pops up once in the corner, goes away by itself and leads to the task when clicked", async () => {
  const connection = await client()
  const group = await newGroup("Popups")
  show()
  const toasts = () => [...document.querySelectorAll<HTMLElement>(".toast")]
  const quiet = await connection.task.create({ group: group.id, title: "Quiet task" })
  await connection.task.cancel({ task: quiet.id })
  await expect
    .poll(() => toasts().map((item) => item.textContent), { timeout: 15000 })
    .toEqual([expect.stringContaining("Quiet task")])
  expect(toasts()).toHaveLength(1)
  await expect.poll(() => toasts().length, { timeout: 10000 }).toBe(0)
  const clicked = await connection.task.create({ group: group.id, title: "Clicked task" })
  await connection.task.cancel({ task: clicked.id })
  await expect.poll(() => toasts().length, { timeout: 15000 }).toBe(1)
  toasts()[0]!.querySelector<HTMLElement>("[data-toast-open]")!.click()
  await expect.poll(where).toBe(`/task/${clicked.id}`)
  expect(toasts()).toHaveLength(0)
}, 60000)

test("with the window in the background a new inbox message is also a system notification", async () => {
  const connection = await client()
  const group = await newGroup("Background")
  const sent: { title: string; body?: string }[] = []
  const original = Object.getOwnPropertyDescriptor(window, "Notification")
  class Fake {
    static permission = "granted"
    onclick: (() => void) | null = null
    constructor(title: string, options?: { body?: string }) {
      sent.push({ title, body: options?.body })
    }
  }
  Object.defineProperty(window, "Notification", { value: Fake, configurable: true })
  const focus = document.hasFocus
  document.hasFocus = () => false
  try {
    show()
    const task = await connection.task.create({ group: group.id, title: "Away task" })
    await connection.task.cancel({ task: task.id })
    await expect.poll(() => sent.length, { timeout: 15000 }).toBe(1)
    expect(sent[0]!.body).toContain("Away task")
  } finally {
    document.hasFocus = focus
    if (original) Object.defineProperty(window, "Notification", original)
  }
}, 60000)

test("the home board lists every unfinished task of the client by stage and expands to the full board", async () => {
  const connection = await client()
  const group = await newGroup("Board group")
  const host = show()
  const loose = await connection.task.create({ title: "Loose idea", project: engine.project })
  const grouped = await connection.task.create({ group: group.id, title: "Grouped work" })
  const dropped = await connection.task.create({ group: group.id, title: "Dropped work" })
  await connection.task.cancel({ task: dropped.id })
  const card = (id: string) => host.querySelector<HTMLElement>(`[data-task="${id}"]`)
  await expect
    .poll(() => card(loose.id)?.closest("[data-column]")?.getAttribute("data-column"), { timeout: 15000 })
    .toBe("todo")
  await expect.poll(() => card(grouped.id), { timeout: 15000 }).not.toBeNull()
  expect(card(grouped.id)!.textContent).toContain("Board group")
  expect(card(loose.id)!.textContent).toContain(t("board.noGroup"))
  expect(card(dropped.id)).toBeNull()
  expect(host.querySelector('[data-column="done"]')).toBeNull()
  const expand = [...host.querySelectorAll("button")].find((button) => button.textContent === t("home.expand"))
  expand!.click()
  await expect.poll(where).toBe("/tasks")
}, 60000)
