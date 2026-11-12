import { Route, Router, useLocation } from "@solidjs/router"
import { render } from "solid-js/web"
import { afterAll, afterEach, beforeAll, expect, test } from "vitest"
import { Home } from "../../app"
import { setLocale, t } from "../../i18n"
import { client } from "../../state/client"
import { connectGroups, homeNotices, loadGroups, localHuman, markNoticesRead, unseenNotices } from "../../state/groups"
import { storage } from "../../lib/bridge"
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

async function newGroup(name: string) {
  const connection = await client()
  const agents = (await connection.agent.list({}))!
  const [leader, worker] = await Promise.all([
    connection.agent.save({
      agent: { ...agents[0]!, id: "", name: `${name} lead`, model: { provider: "fake", model: "fixture" } },
    }),
    connection.agent.save({
      agent: { ...agents[1]!, id: "", name: `${name} writer`, model: { provider: "fake", model: "fixture" } },
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

test("a notice that waits for a decision can be marked read from the inbox and by the tray, and stays read", async () => {
  const connection = await client()
  const group = await newGroup("Read state")
  const host = show()
  await connection.task.create({ group: group.id, member: "worker", title: "Needs a decision", review: true })
  const pendingRow = () =>
    rows(host).find((row) => row.getAttribute("data-pending") === "true" && row.textContent?.includes("Read state"))
  await expect.poll(pendingRow, { timeout: 20000 }).toBeDefined()
  const id = homeNotices().find((entry) => entry.pending && entry.group?.id === group.id)!.notice.id
  expect(unseenNotices()).toContain(id)
  expect(pendingRow()!.getAttribute("data-read")).toBe("false")
  const mark = [...pendingRow()!.querySelectorAll("button")].find(
    (button) => button.textContent === t("inbox.markRead"),
  )
  expect(mark).toBeDefined()
  mark!.click()
  await expect.poll(() => pendingRow()?.getAttribute("data-read"), { timeout: 5000 }).toBe("true")
  expect(unseenNotices()).not.toContain(id)
  expect(await storage.get<string[]>("group-notices-read", [])).toContain(id)
  // The notice still waits for its answer
  expect(homeNotices().some((entry) => entry.pending && entry.notice.id === id)).toBe(true)
  // A finished task adds an information notice; the tray clears decisions and information together
  const done = await connection.task.create({ group: group.id, title: "Finished too" })
  await connection.task.cancel({ task: done.id })
  await expect.poll(() => unseenNotices().length, { timeout: 20000 }).toBeGreaterThan(0)
  markNoticesRead(unseenNotices())
  expect(unseenNotices()).toEqual([])
}, 60000)
