import { Route, Router } from "@solidjs/router"
import { render } from "solid-js/web"
import { afterAll, beforeAll, expect, test } from "vitest"
import { EngineEventSchema } from "@merakcode/sdk"
import { engineFixture } from "../../test/engine"
import { client } from "../../state/client"
import { setLocale } from "../../i18n"
import { loadGroups, localHuman } from "../../state/groups"
import { GroupConversation } from "./group-page"
import { Sidebar } from "../shell/sidebar"

let engine: Awaited<ReturnType<typeof engineFixture>>
beforeAll(async () => {
  engine = await engineFixture({
    replies: [
      { calls: [{ id: "reply", name: "say", input: { text: "I will coordinate this group." } }] },
      { calls: [{ id: "later", name: "say", input: { text: "Later update received." } }] },
      { text: "Task discussion is ready." },
      { calls: [{ id: "mention", name: "say", input: { text: "Task criteria confirmed." } }] },
    ],
  })
  await engine.git("commit", "--allow-empty", "-m", "fixture")
  location.href = engine.url
  setLocale("en")
})
afterAll(async () => {
  try {
    await (await client()).close()
  } finally {
    await engine.close()
  }
})

test("replays group history and sends a mention through the shared composer", async () => {
  const connection = await client()
  const profiles = await connection.profile.list({ human: localHuman })
  const leader = await connection.profile.save({
    human: localHuman,
    profile: { ...profiles![0]!, id: "", model: { provider: "fake", model: "fixture" } },
  })
  const group = await connection.group.create({
    id: "",
    kind: "local",
    name: "Coordination",
    project: { directory: engine.project },
    defaultLeader: "leader",
    members: [
      { id: localHuman, group: "", kind: "human", name: "You", role: "owner", status: "idle" },
      {
        id: "leader",
        group: "",
        kind: "agent",
        name: "Coordinator",
        agentRole: "leader",
        profile: leader.id,
        owner: localHuman,
        status: "idle",
      },
    ],
    profiles: [],
  })
  const batch = await connection.profile.save({
    human: localHuman,
    profile: { ...profiles![1]!, id: "", name: "Batch tool", product: { kind: "command", binary: "unused-command" } },
  })
  await connection.member.register({
    group: group.id,
    human: localHuman,
    member: {
      id: "batch",
      group: group.id,
      kind: "agent",
      name: "Batch tool",
      agentRole: "worker",
      owner: localHuman,
      profile: batch.id,
      status: "idle",
    },
  })
  const host = document.createElement("div")
  document.body.appendChild(host)
  await loadGroups()
  let dispose = render(
    () => (
      <Router>
        <Route
          path="/"
          component={() => (
            <>
              <Sidebar />
              <GroupConversation id={group.id} directory={group.project.directory} />
            </>
          )}
        />
      </Router>
    ),
    host,
  )
  try {
    expect(host.textContent).not.toContain("Messages will be dispatched as new tasks.")
    expect(
      [...host.querySelectorAll("a")].some(
        (link) => link.textContent?.includes("Coordination") && link.href.includes(`/group/${group.id}`),
      ),
    ).toBe(true)
    await expect.poll(() => host.querySelector('button[aria-label="Batch tool"]'), { timeout: 10000 }).not.toBeNull()
    host.querySelector<HTMLButtonElement>('button[aria-label="Batch tool"]')!.click()
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="Message Batch tool"]')?.disabled).toBe(true)
    await expect.poll(() => host.textContent, { timeout: 10000 }).toContain("Messages will be dispatched as new tasks.")
    host.querySelector<HTMLButtonElement>('button[aria-label="Coordinator"]')!.click()
    await expect
      .poll(() => host.querySelector<HTMLButtonElement>('button[aria-label="Message Coordinator"]')?.disabled, {
        timeout: 10000,
      })
      .toBe(false)
    host.querySelector<HTMLButtonElement>('button[aria-label="Message Coordinator"]')!.click()
    const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!
    input.value = "Can you coordinate?"
    input.dispatchEvent(new InputEvent("input", { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
    await expect.poll(() => host.textContent, { timeout: 10000 }).toContain("I will coordinate this group.")
    const facts = (await connection.events.read({ stream: `group:${group.id}`, from: 1 }))!.map((event) =>
      EngineEventSchema.parse(event),
    )
    const said = facts.find((event) => event.type === "human.said")
    expect(said?.payload.to).toEqual(["leader"])
    dispose()
    dispose = render(
      () => (
        <Router>
          <Route path="/" component={() => <Sidebar />} />
        </Router>
      ),
      host,
    )
    await connection.group.say({ group: group.id, human: localHuman, text: "A later update" })
    await expect
      .poll(() => host.querySelector(`[data-unread-group="${group.id}"]`)?.textContent, { timeout: 10000 })
      .toBe("1")
    dispose()
    dispose = render(
      () => (
        <Router>
          <Route
            path="/"
            component={() => (
              <>
                <Sidebar />
                <GroupConversation id={group.id} directory={group.project.directory} />
              </>
            )}
          />
        </Router>
      ),
      host,
    )
    await expect.poll(() => host.textContent, { timeout: 10000 }).toContain("Later update received.")
    expect(host.querySelectorAll('[data-group-message="assistant"]')).toHaveLength(2)
    expect(host.querySelector(`[data-unread-group="${group.id}"]`)).toBeNull()
    const task = await connection.task.create({
      group: group.id,
      human: localHuman,
      title: "Check the task discussion",
    })
    await expect
      .poll(() => host.querySelector(`select[aria-label="Discussion"] option[value="${task.id}"]`), { timeout: 10000 })
      .not.toBeNull()
    const discussion = host.querySelector<HTMLSelectElement>('select[aria-label="Discussion"]')!
    discussion.value = task.id
    discussion.dispatchEvent(new Event("change", { bubbles: true }))
    const taskInput = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!
    taskInput.value = "Keep the existing acceptance criteria."
    taskInput.dispatchEvent(new InputEvent("input", { bubbles: true }))
    taskInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
    await expect
      .poll(
        async () => {
          const facts = (await connection.events.read({ stream: `group:${group.id}`, from: 1 }))!.map((event) =>
            EngineEventSchema.parse(event),
          )
          return facts.find(
            (event) =>
              event.type === "human.said" &&
              event.scope.task === task.id &&
              event.payload.text === "Keep the existing acceptance criteria.",
          )
        },
        { timeout: 10000 },
      )
      .toBeDefined()
    expect(host.querySelector('[data-group-message="human"]')?.textContent).toContain(
      "Keep the existing acceptance criteria.",
    )
    expect(host.textContent).not.toContain("Can you coordinate?")
    await expect.poll(() => taskInput.value).toBe("")
    taskInput.value = "@Coordinator Please check these criteria."
    taskInput.dispatchEvent(new InputEvent("input", { bubbles: true }))
    taskInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
    await expect
      .poll(
        async () => {
          const facts = (await connection.events.read({ stream: `group:${group.id}`, from: 1 }))!.map((event) =>
            EngineEventSchema.parse(event),
          )
          const said = facts.find(
            (event) =>
              event.type === "human.said" && event.payload.text === "@Coordinator Please check these criteria.",
          )
          return said?.type === "human.said" ? { task: said.scope.task, to: said.payload.to } : undefined
        },
        { timeout: 10000 },
      )
      .toEqual({ task: task.id, to: ["leader"] })
  } finally {
    dispose()
    host.remove()
  }
})
