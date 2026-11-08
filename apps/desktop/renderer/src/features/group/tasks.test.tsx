import { Route, Router } from "@solidjs/router"
import { render } from "solid-js/web"
import { afterAll, beforeAll, expect, test } from "vitest"
import { EngineEventSchema } from "@merakcode/sdk"
import { engineFixture } from "../../test/engine"
import { client } from "../../state/client"
import { setLocale } from "../../i18n"
import { localHuman } from "../../state/groups"
import { GroupConversation } from "../conversation/group-page"

let engine: Awaited<ReturnType<typeof engineFixture>>
beforeAll(async () => {
  engine = await engineFixture()
  await engine.git("commit", "--allow-empty", "-m", "Fixture")
  location.href = engine.url
  setLocale("en")
})
afterAll(async () => {
  await (await client()).close()
  await engine?.close()
})

test("creates a task from the group's board with its acceptance criteria and reviewer", async () => {
  const connection = await client()
  const profiles = await connection.profile.list({ human: localHuman })
  const leader = await connection.profile.save({
    human: localHuman,
    profile: { ...profiles![0]!, id: "", model: { provider: "fake", model: "fixture" } },
  })
  const worker = await connection.profile.save({
    human: localHuman,
    profile: { ...profiles![1]!, id: "", model: { provider: "fake", model: "fixture" } },
  })
  const group = await connection.group.create({
    id: "",
    kind: "local",
    name: "Delivery",
    project: { directory: engine.project },
    defaultLeader: "leader",
    profiles: [],
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
      {
        id: "worker",
        group: "",
        kind: "agent",
        name: "Writer",
        agentRole: "worker",
        profile: worker.id,
        owner: localHuman,
        status: "idle",
      },
    ],
  })
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(
    () => (
      <Router>
        <Route path="/" component={() => <GroupConversation id={group.id} directory={engine.project} />} />
      </Router>
    ),
    host,
  )
  const click = async (label: string, root: ParentNode = document) => {
    const button = () =>
      [...root.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)
    await expect.poll(button, { message: label }).toBeDefined()
    button()!.click()
  }
  const fill = (label: string, value: string) => {
    const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!
    input.value = value
    input.dispatchEvent(new InputEvent("input", { bubbles: true }))
  }
  try {
    await expect.poll(() => host.textContent, { timeout: 10000 }).toContain("Delivery")
    await click("Task board", host)
    await click("Create task", host)
    fill("Title", "Update the guide")
    fill("Description", "Document the new behavior.")
    fill("Acceptance criteria", "Examples pass\nLinks work")
    const review = document.querySelector<HTMLInputElement>('input[aria-label="Require review"]')!
    review.checked = true
    review.dispatchEvent(new Event("change", { bubbles: true }))
    await click("Create task", document.querySelector('[role="dialog"]')!)
    await expect
      .poll(() => host.querySelector('[aria-label="Open tasks"]')?.textContent, { timeout: 10000 })
      .toContain("Update the guide")
    const events = (await connection.events.read({ stream: `group:${group.id}`, from: 1 }))!.map((event) =>
      EngineEventSchema.parse(event),
    )
    const created = events.find((event) => event.type === "task.created")!
    if (created.type !== "task.created") throw new Error("Task creation event is missing")
    expect(created.payload).toMatchObject({
      title: "Update the guide",
      description: "Document the new behavior.",
      acceptance: ["Examples pass", "Links work"],
      review: true,
      leader: "leader",
      createdBy: { id: localHuman, kind: "human" },
    })
    host.querySelector<HTMLButtonElement>('[aria-label="Open tasks"] .task-card')!.click()
    await expect.poll(() => document.querySelector(".task-detail")?.textContent).toContain("Examples pass")
    await click("Cancel task", document.querySelector(".task-detail")!.closest('[role="dialog"]')!)
    await expect
      .poll(async () => {
        const facts = (await connection.events.read({ stream: `group:${group.id}`, from: 1 }))!.map((event) =>
          EngineEventSchema.parse(event),
        )
        return facts.some(
          (event) =>
            event.type === "task.closed" &&
            event.scope.task === created.payload.id &&
            event.payload.status === "cancelled",
        )
      })
      .toBe(true)
    await expect
      .poll(() => host.querySelector('[aria-label="Cancelled tasks"]')?.textContent)
      .toContain("Update the guide")
    await click("Close", document.querySelector(".task-detail")!.closest('[role="dialog"]')!)
    await expect.poll(() => document.querySelector(".task-detail")).toBeNull()
    await connection.task.create({ group: group.id, human: localHuman, title: "Verify guide", review: true })
    await expect.poll(() => host.querySelector('[aria-label="Open tasks"]')?.textContent).toContain("Verify guide")
    host.querySelector<HTMLButtonElement>('[aria-label="Open tasks"] .task-card')!.click()
    const assign = document.querySelector<HTMLSelectElement>('select[aria-label="Assign member"]')
    expect(assign).not.toBeNull()
    assign!.value = "worker"
    assign!.dispatchEvent(new Event("change", { bubbles: true }))
    await click("Assign member", document.querySelector(".task-detail")!.closest('[role="dialog"]')!)
    await expect
      .poll(() => host.querySelector('[aria-label="Review tasks"]')?.textContent, { timeout: 10000 })
      .toContain("Verify guide")
    await expect
      .poll(() => document.querySelector('[aria-label="Worker report"]')?.textContent)
      .toContain("Feedback received")
    const process = [...document.querySelectorAll("details")].find(
      (element) => element.querySelector("summary")?.textContent === "Execution process",
    )
    expect(process).toBeDefined()
    process!.open = true
    process!.dispatchEvent(new Event("toggle"))
    await expect
      .poll(() => process!.querySelector('[role="log"]')?.textContent, { timeout: 10000 })
      .toContain("Please submit your report with submit_report")
    await click("Close", document.querySelector(".task-detail")!.closest('[role="dialog"]')!)
    await expect.poll(() => document.querySelector(".task-detail")).toBeNull()
    await click("Inbox", host)
    await expect.poll(() => host.querySelector('[aria-label="To do"]')?.textContent).toContain("Verify guide")
    const info = host.querySelector('[aria-label="Information"]')!
    expect(info.textContent).toContain("Update the guide")
    await click("Mark as read", info)
    await expect.poll(() => info.textContent).toContain("Read")
    expect(info.textContent).not.toContain("Mark as read")
    await click("Verify guide", host.querySelector('[aria-label="To do"]')!)
    await expect
      .poll(() => document.querySelector('[aria-label="Worker report"]')?.textContent)
      .toContain("Feedback received")
  } finally {
    dispose()
    host.remove()
  }
})
