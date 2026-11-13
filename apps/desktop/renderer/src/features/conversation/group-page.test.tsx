import { Route, Router, useLocation } from "@solidjs/router"
import { render } from "solid-js/web"
import { afterAll, beforeAll, expect, test } from "vitest"
import { EngineEventSchema } from "@merakcode/sdk"
import { engineFixture } from "../../test/engine"
import { client } from "../../state/client"
import { setLocale, t } from "../../i18n"
import { connectGroups, groupView, loadGroups, localHuman } from "../../state/groups"
import { connect } from "../../state/store"
import { GroupConversation } from "./group-page"
import { Sidebar } from "../shell/sidebar"

let engine: Awaited<ReturnType<typeof engineFixture>>
let stop = () => {}
beforeAll(async () => {
  engine = await engineFixture({
    replies: [
      {
        role: "leader",
        calls: [
          { id: "split", name: "create_task", input: { title: "Check the guide", description: "Read every page." } },
        ],
      },
      { role: "leader", calls: [{ id: "reply", name: "say", input: { text: "I split the work for you." } }] },
      ...Array.from({ length: 6 }, (_, index) => ({
        role: "leader",
        calls: [{ id: `again-${index}`, name: "say", input: { text: `Noted ${index}.` } }],
      })),
    ],
  })
  await engine.git("commit", "--allow-empty", "-m", "fixture")
  location.href = engine.url
  setLocale("en")
  const stopStore = connect()
  const stopGroups = connectGroups()
  stop = () => {
    stopGroups()
    stopStore()
  }
  await client()
})
afterAll(async () => {
  stop()
  try {
    await (await client()).close()
  } finally {
    await engine.close()
  }
})

function Where() {
  const location = useLocation()
  return <output data-where>{location.pathname}</output>
}

const click = async (root: ParentNode, label: string) => {
  const find = () =>
    [...root.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
    )
  await expect.poll(find, { message: label, timeout: 10000 }).toBeDefined()
  find()!.click()
}

const leaderAgent = async () =>
  (await client()).agent.save({
    agent: { ...(await (await client()).agent.list({}))![0]!, id: "", model: { provider: "fake", model: "fixture" } },
  })

const member = (id: string, name: string, agentRole: string, agent: string) => ({
  id,
  group: "",
  kind: "agent",
  name,
  agentRole,
  agent,
  owner: localHuman,
  status: "idle",
})

test("the Leader's work shows as tool cards, a created task as a card, and the breakdown follows the Leader's tasks", async () => {
  const connection = await client()
  const lead = await leaderAgent()
  const group = await connection.group.create({
    id: "",
    kind: "local",
    name: "Coordination",
    project: { directory: engine.project },
    leader: "leader",
    members: [
      { id: localHuman, group: "", kind: "human", name: "You", role: "owner", status: "idle" },
      member("leader", "Coordinator", "leader", lead.id),
    ],
  })
  await loadGroups()
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <Router>
        <Route
          path="/"
          component={() => (
            <>
              <Sidebar />
              <GroupConversation id={group.id} directory={group.project.directory} />
              <Where />
            </>
          )}
        />
        <Route path="/task/:id" component={Where} />
      </Router>
    ),
    host,
  )
  try {
    expect(host.querySelector('select[aria-label="Discussion"]')).toBeNull()
    expect(host.querySelector('[role="tablist"]')).toBeNull()
    const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!
    input.value = "Please check the guide."
    input.dispatchEvent(new InputEvent("input", { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
    await expect.poll(() => host.textContent, { timeout: 15000 }).toContain("I split the work for you.")
    expect(host.querySelector('[data-group-message="human"]')?.textContent).toContain("Please check the guide.")
    await expect.poll(() => host.querySelector('[data-group-message="assistant"]'), { timeout: 10000 }).not.toBeNull()
    const reply = host.querySelector('[data-group-message="assistant"]')!
    expect(reply.textContent).toContain("Coordinator")
    const work = host.querySelector<HTMLDetailsElement>('[data-group-message="work"]')!
    expect(work.textContent).toContain("create_task")
    expect(work.textContent).not.toContain("I split the work for you.")
    const card = host.querySelector<HTMLButtonElement>("[data-group-task]")!
    expect(card.textContent).toContain("Check the guide")
    const taskId = card.getAttribute("data-group-task")!
    await expect
      .poll(() => host.querySelector(`[aria-label="Task breakdown"] [data-task="${taskId}"]`)?.textContent, {
        timeout: 10000,
      })
      .toContain("Check the guide")
    card.click()
    await expect.poll(() => document.querySelector("[data-where]")?.textContent).toBe(`/task/${taskId}`)
  } finally {
    dispose()
    host.remove()
  }
}, 60000)

test("an @ names the member, the roster renames and removes members, and the add list marks who is in the group", async () => {
  const connection = await client()
  const agents = (await connection.agent.list({}))!
  const [writer, checker] = await Promise.all(
    ["Writer", "Checker"].map((name) =>
      connection.agent.save({ agent: { ...agents[0]!, id: "", name, model: { provider: "fake", model: "fixture" } } }),
    ),
  )
  const lead = await leaderAgent()
  const group = await connection.group.create({
    id: "",
    kind: "local",
    name: "Roster",
    project: { directory: engine.project },
    leader: "leader",
    members: [
      { id: localHuman, group: "", kind: "human", name: "You", role: "owner", status: "idle" },
      member("leader", "Boss", "leader", lead.id),
      member("writer", "Writer", "worker", writer!.id),
    ],
  })
  await loadGroups()
  window.history.replaceState({}, "", "/")
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <Router>
        <Route path="/" component={() => <GroupConversation id={group.id} directory={group.project.directory} />} />
      </Router>
    ),
    host,
  )
  try {
    const members = () => groupView(group.id)?.members.map((item) => item.name)
    await expect.poll(members, { timeout: 15000 }).toContain("Writer")
    await click(host, "Writer")
    const name = () => host.querySelector<HTMLInputElement>('input[aria-label="Name"]')!
    await expect.poll(name).not.toBeNull()
    name().value = "Poet"
    name().dispatchEvent(new InputEvent("input", { bubbles: true }))
    await click(host, t("group.save"))
    await expect.poll(members, { timeout: 10000 }).toContain("Poet")
    expect(members()).not.toContain("Writer")
    await expect.poll(() => name()?.value, { timeout: 10000 }).toBe("Poet")
    name().value = "Boss"
    name().dispatchEvent(new InputEvent("input", { bubbles: true }))
    await expect.poll(() => host.textContent).toContain(t("group.nameTaken"))
    expect(
      [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === t("group.save"))!
        .disabled,
    ).toBe(true)
    await click(host, t("group.addMember"))
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]:not([data-closed])')!
    await expect.poll(dialog, { timeout: 10000 }).not.toBeNull()
    await expect
      .poll(() => dialog().querySelector(`[data-agent="${writer!.id}"]`)?.textContent, { timeout: 10000 })
      .toContain(t("group.alreadyIn"))
    await click(dialog(), t("profiles.add", { name: "Checker" }))
    await expect.poll(members, { timeout: 10000 }).toContain("Checker")
    expect(groupView(group.id)?.members.find((item) => item.agent === checker!.id)?.agentRole).toBe("worker")
    await click(dialog(), t("common.close"))
    await expect.poll(() => document.querySelector('[role="dialog"]:not([data-closed])')).toBeNull()
    await click(host, t("group.remove"))
    await click(document.querySelector<HTMLElement>('[role="dialog"]:not([data-closed])')!, t("group.remove"))
    await expect.poll(members, { timeout: 10000 }).not.toContain("Poet")
    const checkerMember = groupView(group.id)!.members.find((item) => item.agent === checker!.id)!.id
    await expect.poll(() => host.querySelector('textarea[aria-label="Message"]'), { timeout: 10000 }).not.toBeNull()
    const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!
    input.value = "@Checker please start"
    input.dispatchEvent(new InputEvent("input", { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
    await expect
      .poll(async () => {
        const facts = (await connection.events.read({ stream: `group:${group.id}`, from: 1 }))!.map((event) =>
          EngineEventSchema.parse(event),
        )
        const said = facts.find((event) => event.type === "human.said")
        return said?.type === "human.said" ? said.payload.to : undefined
      })
      .toEqual([checkerMember])
  } finally {
    dispose()
    host.remove()
  }
}, 60000)
