import { execFile } from "node:child_process"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { Route, Router, useLocation } from "@solidjs/router"
import { render } from "solid-js/web"
import { afterAll, afterEach, beforeAll, expect, test } from "vitest"
import type { EngineEvent } from "@merakcode/sdk"
import { setLocale, t } from "../../i18n"
import { client } from "../../state/client"
import { connectGroups, loadGroups, localHuman } from "../../state/groups"
import { connect, setState } from "../../state/store"
import { connectTasks, loadTasks, receiveTaskEvent } from "../../state/tasks"
import { engineFixture } from "../../test/engine"
import { Toasts } from "../../ui/toast"
import { TaskBoardPage } from "./board"
import { TaskPage } from "./page"

let engine: Awaited<ReturnType<typeof engineFixture>>
let elsewhere: string
let stop = () => {}
beforeAll(async () => {
  engine = await engineFixture()
  location.href = engine.url
  await engine.git("commit", "--allow-empty", "-m", "Fixture")
  elsewhere = await mkdtemp(path.join(tmpdir(), "merak-elsewhere-"))
  const git = (...args: string[]) => promisify(execFile)("git", args, { cwd: elsewhere, windowsHide: true })
  await git("init", "-b", "main")
  await git("config", "user.name", "Fixture")
  await git("config", "user.email", "fixture@example.invalid")
  await git("commit", "--allow-empty", "-m", "Fixture")
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
}, 60000)
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

function Where() {
  const location = useLocation()
  return <output data-where>{location.pathname}</output>
}

function show(path: string) {
  window.history.replaceState({}, "", path)
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <Router
        root={(props) => (
          <>
            {props.children}
            <Where />
            <Toasts />
          </>
        )}
      >
        <Route path="/task/:id" component={TaskPage} />
        <Route path="/tasks" component={TaskBoardPage} />
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

const where = () => document.querySelector("[data-where]")?.textContent
const find = (root: ParentNode, label: string) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
  )
const click = async (root: ParentNode, label: string) => {
  await expect.poll(() => find(root, label), { message: label, timeout: 10000 }).toBeDefined()
  find(root, label)!.click()
}
const openDialog = () => document.querySelector<HTMLElement>('[role="dialog"]:not([data-closed])')!

async function leaderAgent(name = "Chief") {
  const connection = await client()
  return connection.agent.save({
    agent: { ...(await connection.agent.list({}))![0]!, id: "", name, model: { provider: "fake", model: "fixture" } },
  })
}

async function newGroup(name: string, directory: string) {
  const connection = await client()
  const lead = await leaderAgent(`${name}Lead`)
  const group = await connection.group.create({
    id: "",
    kind: "local",
    name,
    project: { directory },
    leader: "leader",
    members: [
      { id: localHuman, group: "", kind: "human", name: "You", role: "owner", status: "idle" },
      {
        id: "leader",
        group: "",
        kind: "agent",
        name: `${name}Lead`,
        agentRole: "leader",
        agent: lead.id,
        owner: localHuman,
        status: "idle",
      },
    ],
  })
  await loadGroups()
  return group
}

async function looseTask(title: string, project = engine.project) {
  const card = await (await client()).task.create({ title, project, description: "Do it.", acceptance: ["It works"] })
  await loadTasks()
  return card
}

test("a task without a group says it waits for one and offers to start a new group or pick one", async () => {
  const card = await looseTask("Solo work")
  show(`/task/${card.id}`)
  await expect.poll(() => document.body.textContent, { timeout: 10000 }).toContain(t("task.needsGroup"))
  expect(find(document, t("task.newGroup"))).toBeDefined()
  expect(find(document, t("task.chooseGroup"))).toBeDefined()
  expect(document.body.textContent).toContain("Solo work")
  expect(document.body.textContent).toContain("It works")
})

test("a new group for a task has the task's workspace, fixed, and takes the task when created", async () => {
  const connection = await client()
  const card = await looseTask("Start a group")
  await leaderAgent("Task chief")
  const before = (await connection.agent.list({}))!.length
  show(`/task/${card.id}`)
  await click(document, t("task.newGroup"))
  await expect.poll(openDialog, { timeout: 10000 }).not.toBeNull()
  const workspace = () => openDialog().querySelector<HTMLButtonElement>('button[aria-label="Workspace"]')!
  await expect.poll(workspace, { timeout: 10000 }).not.toBeNull()
  expect(workspace().disabled).toBe(true)
  expect(openDialog().textContent).toContain(path.basename(engine.project))
  const create = () => find(openDialog(), t("group.create"))!
  const trigger = () => openDialog().querySelector<HTMLButtonElement>(`button[aria-label^="${t("group.leader")}"]`)!
  await expect.poll(trigger, { timeout: 10000 }).not.toBeNull()
  await expect.poll(() => trigger().textContent, { timeout: 10000 }).toContain("Leader")
  trigger().dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, pointerType: "mouse" }))
  await expect
    .poll(() => [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => option.textContent), {
      timeout: 10000,
    })
    .toEqual(expect.arrayContaining([expect.stringContaining("Task chief"), expect.stringContaining("Leader")]))
  const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(
    (option) => option.textContent ?? "",
  )
  expect(options.some((label) => label.includes("Worker"))).toBe(false)
  ;[...document.querySelectorAll<HTMLElement>('[role="option"]')]
    .find((option) => option.textContent?.includes("Task chief"))!
    .click()
  await expect.poll(() => create().disabled, { timeout: 15000 }).toBe(false)
  create().click()
  await expect
    .poll(async () => (await connection.task.list({}))!.find((item) => item.id === card.id)?.group, { timeout: 15000 })
    .toBeTruthy()
  const bound = (await connection.task.list({}))!.find((item) => item.id === card.id)!
  const group = (await connection.group.list())!.find((item) => item.id === bound.group)!
  expect(group.project.directory).toBe(bound.project)
  expect(await connection.agent.list({})).toHaveLength(before)
  await expect.poll(where, { timeout: 10000 }).toContain(`/group/${group.id}`)
})

test("choosing a group lists every group, warns about a move, and gives the task to the one picked", async () => {
  const connection = await client()
  const same = await newGroup("Same", engine.project)
  const other = await newGroup("Other", elsewhere)
  const card = await looseTask("Pick a group")
  show(`/task/${card.id}`)
  await click(document, t("task.chooseGroup"))
  await expect.poll(openDialog, { timeout: 10000 }).not.toBeNull()
  const row = (id: string) => openDialog().querySelector<HTMLElement>(`[data-group="${id}"]`)
  await expect.poll(() => row(same.id) && row(other.id), { timeout: 10000 }).toBeTruthy()
  expect(row(other.id)!.textContent).toContain(t("task.chooseMove"))
  expect(row(same.id)!.textContent).not.toContain(t("task.chooseMove"))
  expect(find(row(other.id)!, t("task.choose"))!.disabled).toBe(false)
  find(row(same.id)!, t("task.choose"))!.click()
  await expect
    .poll(async () => (await connection.task.list({}))!.find((item) => item.id === card.id)?.group, { timeout: 15000 })
    .toBe(same.id)
  await expect.poll(() => document.body.textContent, { timeout: 10000 }).toContain("SameLead")
  expect(find(document, t("task.newGroup"))).toBeUndefined()
  expect(find(document, t("task.chooseGroup"))).toBeUndefined()
  const link = [...document.querySelectorAll("a, button")].find((item) => item.textContent?.includes("Same"))
  expect(link).toBeDefined()
})

test("a group elsewhere is greyed out with the reason while it has work running", async () => {
  const connection = await client()
  const other = await newGroup("Busy elsewhere", elsewhere)
  await loadGroups()
  const lead = await leaderAgent("Slow")
  const slow = await connection.agent.save({
    agent: {
      id: "",
      name: "Sleeper",
      role: "worker",
      summary: "",
      duties: "",
      toolPool: "worker.default",
      model: { provider: "", model: "" },
      product: { kind: "command", binary: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"] },
    },
  })
  await connection.group.addMember({
    group: other.id,
    member: {
      id: "sleeper",
      group: other.id,
      kind: "agent",
      name: "Sleeper",
      agentRole: "worker",
      agent: slow.id,
      owner: localHuman,
      status: "idle",
    },
  })
  expect(lead.id).toBeTruthy()
  await connection.task.create({ group: other.id, member: "sleeper", title: "Long job" })
  const card = await looseTask("Wants the busy group")
  show(`/task/${card.id}`)
  await click(document, t("task.chooseGroup"))
  const row = () => openDialog()?.querySelector<HTMLElement>(`[data-group="${other.id}"]`)
  await expect.poll(() => row()?.getAttribute("data-busy"), { timeout: 20000 }).toBe("true")
  expect(row()!.textContent).toContain(t("task.chooseBusy"))
  expect(find(row()!, t("task.choose"))!.disabled).toBe(true)
}, 60000)

test("a claim a worker took by itself says so, and one it was given does not", async () => {
  const connection = await client()
  const group = await newGroup("Claimers", engine.project)
  const card = await connection.task.create({ group: group.id, title: "Claimed work" })
  const claim = { id: "claim-self", member: "self-worker", task: card.id, role: "owner", status: "queued" }
  const event = {
    id: "01ZZZZZZZZZZZZZZZZZZZZZZZZ",
    type: "task.queued",
    stream: `group:${group.id}`,
    scope: { group: group.id, task: card.id },
    time: new Date().toISOString(),
    seq: 9999,
    actor: { kind: "agent", id: "self-worker" },
    payload: { ...card, claims: [claim] },
  } as unknown as EngineEvent
  receiveTaskEvent(event)
  show(`/task/${card.id}`)
  await expect.poll(() => document.body.textContent, { timeout: 10000 }).toContain("Claimed work")
  await expect
    .poll(() => document.querySelector("[data-claim]")?.textContent, { timeout: 10000 })
    .toContain(t("task.claimSelf", { name: "self-worker" }))
})

const finished = async (title: string) => {
  const connection = await client()
  const card = await connection.task.create({ title, project: engine.project })
  await connection.task.cancel({ task: card.id })
  return card
}

test("archiving a finished card takes it off the board into the archive, where it can be found and restored", async () => {
  const connection = await client()
  const card = await finished("Old finished work")
  await loadTasks()
  const host = show("/tasks")
  const onBoard = () => host.querySelector(`[data-column] [data-task="${card.id}"]`)
  await expect.poll(onBoard, { timeout: 10000 }).not.toBeNull()
  await click(host, t("tasks.archiveCard", { title: "Old finished work" }))
  await expect.poll(onBoard, { timeout: 10000 }).toBeNull()
  expect((await connection.task.list({ archived: true }))!.some((item) => item.id === card.id)).toBe(true)
  await click(host, t("tasks.archived"))
  const listed = () => host.querySelector(`[data-archived="${card.id}"]`)
  await expect.poll(listed, { timeout: 10000 }).not.toBeNull()
  const search = host.querySelector<HTMLInputElement>(`input[aria-label="${t("tasks.search")}"]`)!
  search.value = "no such task"
  search.dispatchEvent(new InputEvent("input", { bubbles: true }))
  await expect.poll(listed).toBeNull()
  expect(host.textContent).toContain(t("tasks.noMatch"))
  search.value = "old finished"
  search.dispatchEvent(new InputEvent("input", { bubbles: true }))
  await expect.poll(listed).not.toBeNull()
  await click(host, t("tasks.restoreCard", { title: "Old finished work" }))
  await expect.poll(listed, { timeout: 10000 }).toBeNull()
  await expect.poll(async () => (await connection.task.list({}))!.some((item) => item.id === card.id)).toBe(true)
})

test("an unfinished card asks first and is cancelled, then archived", async () => {
  const connection = await client()
  const card = await connection.task.create({ title: "Still going", project: engine.project })
  await loadTasks()
  const host = show("/tasks")
  await click(host, t("tasks.archiveCard", { title: "Still going" }))
  await expect.poll(openDialog, { timeout: 10000 }).not.toBeNull()
  expect(openDialog().textContent).toContain(t("tasks.archiveConfirmDetail"))
  expect((await connection.task.list({}))!.find((item) => item.id === card.id)?.status).not.toBe("cancelled")
  await click(openDialog(), t("common.cancel"))
  await expect.poll(() => document.querySelector('[role="dialog"]:not([data-closed])')).toBeNull()
  expect((await connection.task.list({ archived: true }))!.some((item) => item.id === card.id)).toBe(false)
  await click(host, t("tasks.archiveCard", { title: "Still going" }))
  await expect.poll(openDialog, { timeout: 10000 }).not.toBeNull()
  await click(openDialog(), t("tasks.archiveConfirm"))
  await expect
    .poll(async () => (await connection.task.list({ archived: true }))!.find((item) => item.id === card.id)?.status, {
      timeout: 10000,
    })
    .toBe("cancelled")
})

test("the finished column archives all its cards at once", async () => {
  const connection = await client()
  const cards = await Promise.all([finished("Batch one"), finished("Batch two")])
  await loadTasks()
  const host = show("/tasks")
  const column = () => host.querySelector<HTMLElement>('[data-column="done"]')!
  await expect
    .poll(() => column()?.querySelectorAll("[data-task]").length, { timeout: 10000 })
    .toBeGreaterThanOrEqual(2)
  const count = column().querySelectorAll("[data-task]").length
  await click(column(), t("tasks.archiveAllCount", { count }))
  await expect
    .poll(
      async () => {
        const archived = new Set((await connection.task.list({ archived: true }))!.map((item) => item.id))
        return cards.every((card) => archived.has(card.id))
      },
      { timeout: 10000 },
    )
    .toBe(true)
  await expect.poll(() => column().querySelectorAll("[data-task]").length, { timeout: 10000 }).toBe(0)
})

test("a task the engine archives on its own leaves the board without the page doing anything", async () => {
  const connection = await client()
  const card = await finished("Archived elsewhere")
  await loadTasks()
  const host = show("/tasks")
  const onBoard = () => host.querySelector(`[data-column] [data-task="${card.id}"]`)
  await expect.poll(onBoard, { timeout: 10000 }).not.toBeNull()
  await connection.task.archive({ tasks: [card.id], archived: true })
  await expect.poll(onBoard, { timeout: 10000 }).toBeNull()
})
