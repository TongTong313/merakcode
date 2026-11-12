import { Route, Router } from "@solidjs/router"
import { render } from "solid-js/web"
import { afterAll, afterEach, beforeAll, expect, test } from "vitest"
import { Home, Workspace } from "../../app"
import { setLocale, t } from "../../i18n"
import { sessionPath } from "../../lib/route"
import { client } from "../../state/client"
import { connectGroups, loadGroups, localHuman } from "../../state/groups"
import { connect, setState } from "../../state/store"
import { connectTasks } from "../../state/tasks"
import { engineFixture } from "../../test/engine"

let engine: Awaited<ReturnType<typeof engineFixture>>
let stop = () => {}
beforeAll(async () => {
  engine = await engineFixture()
  location.href = engine.url
  await engine.git("commit", "--allow-empty", "-m", "Fixture")
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
  setState("folders", [])
  localStorage.clear()
  window.history.replaceState({}, "", "/")
})

function open(directory: string | undefined, folders: string[]) {
  setLocale("zh")
  setState(
    "folders",
    folders.map((folder) => ({ directory: folder })),
  )
  window.history.replaceState({}, "", directory ? sessionPath(directory) : "/")
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <Router>
        <Route path="/" component={Home} />
        <Route path="/:dir/session/:id?" component={Workspace} />
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

const label = (element: Element) =>
  [...element.childNodes]
    .filter((node) => !(node instanceof HTMLElement && node.tagName === "KBD"))
    .map((node) => node.textContent)
    .join("")
    .trim()

test("the top of the sidebar is home, new conversation, new agent, new group and new task, in that order", () => {
  const host = open(engine.project, [engine.project])
  const rows = [...host.querySelectorAll(".sidebar-actions > .nav-row")].slice(0, 5)
  expect(rows.map(label)).toEqual([
    t("sidebar.home"),
    t("sidebar.new"),
    t("sidebar.agent"),
    t("sidebar.group"),
    t("sidebar.task"),
  ])
  expect(rows[0]!.tagName).toBe("A")
  expect(rows[0]!.getAttribute("href")).toBe("/")
})

test("a workspace lists its groups, tasks and conversations by latest change", async () => {
  const connection = await client()
  const created = await connection.session.create({ provider: "fake", model: "fixture", workdir: engine.project })
  await connection.session.send({ session: created.session, parts: [{ text: "First conversation" }] })
  await expect
    .poll(
      async () =>
        (await connection.events.find({ scope: { session: created.session }, types: ["turn.finished"] }))?.length,
      {
        timeout: 10000,
      },
    )
    .toBe(1)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const task = await connection.task.create({ title: "Loose task", project: engine.project })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const group = await connection.group.create({
    id: "",
    kind: "local",
    name: "Newest group",
    project: { directory: engine.project },
    leader: "leader",
    members: [
      { id: localHuman, group: "", kind: "human", name: "You", role: "owner", status: "idle" },
      {
        id: "leader",
        group: "",
        kind: "agent",
        name: "Leader",
        agentRole: "leader",
        agent: "builtin-leader",
        status: "idle",
      },
    ],
  })
  await loadGroups()
  const host = open(engine.project, [engine.project])
  await expect
    .poll(() => [...host.querySelectorAll("[data-entry]")].map((row) => row.getAttribute("data-entry")), {
      timeout: 10000,
    })
    .toEqual([`group:${group.id}`, `task:${task.id}`, `session:${created.session}`])
  const links = [...host.querySelectorAll<HTMLAnchorElement>("a[data-entry]")]
  expect(links[0]!.getAttribute("href")).toContain(`/group/${group.id}`)
  expect(links[1]!.getAttribute("href")).toBe(`/task/${task.id}`)
  expect(links[2]!.getAttribute("href")).toContain(`/session/${created.session}`)
})

test("with no workspace open the sidebar offers to open a folder", () => {
  const host = open(undefined, [])
  const scroll = host.querySelector(".sidebar-scroll")!
  const button = [...scroll.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(t("sidebar.openFolder")),
  )
  expect(button).toBeDefined()
})
