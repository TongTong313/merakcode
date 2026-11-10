import { execFile } from "node:child_process"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { Route, Router } from "@solidjs/router"
import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { afterAll, beforeAll, expect, test, vi } from "vitest"
import { EngineEventSchema } from "@merakcode/sdk"
import { engineFixture } from "../../test/engine"
import { client } from "../../state/client"
import { setLocale } from "../../i18n"
import { localHuman } from "../../state/groups"
import { GroupConversation } from "../conversation/group-page"
import { TaskReview } from "./review"

let engine: Awaited<ReturnType<typeof engineFixture>>
beforeAll(async () => {
  vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) =>
    window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 50 }), 0),
  )
  engine = await engineFixture()
  await writeFile(path.join(engine.project, "guide.txt"), "Original guide\n")
  await engine.git("add", ".")
  await engine.git("commit", "-m", "Fixture")
  location.href = engine.url
  setLocale("en")
})
afterAll(async () => {
  await (await client()).close()
  await engine?.close()
  vi.unstubAllGlobals()
})

async function createGroup() {
  const connection = await client()
  const defaults = (await connection.profile.list({ human: localHuman }))!
  const profiles = await Promise.all(
    defaults.slice(0, 2).map((profile) =>
      connection.profile.save({
        human: localHuman,
        profile: { ...profile, id: "", model: { provider: "fake", model: "fixture" } },
      }),
    ),
  )
  return connection.group.create({
    id: "",
    kind: "local",
    name: "Task review",
    project: { directory: engine.project },
    defaultLeader: "leader",
    settings: { mergeNeedsOwner: false },
    profiles: [],
    members: [
      { id: localHuman, group: "", kind: "human", name: "You", role: "owner", status: "idle" },
      ...(["leader", "worker"] as const).map((role, index) => ({
        id: role,
        group: "",
        kind: "agent" as const,
        name: role,
        agentRole: role,
        profile: profiles[index]!.id,
        owner: localHuman,
        status: "idle",
      })),
    ],
  })
}

test("reviews the task baseline, returns collected feedback to the original claim, then approves", async () => {
  const connection = await client()
  const group = await createGroup()
  const card = await connection.task.create({
    group: group.id,
    human: localHuman,
    title: "Review guide",
    member: "worker",
    review: true,
  })
  const events = async () =>
    (await connection.events.read({ stream: `group:${group.id}`, from: 1 }))!.map((event) =>
      EngineEventSchema.parse(event),
    )
  await expect
    .poll(
      async () => (await events()).some((event) => event.type === "task.reported" && event.scope.task === card.id),
      { timeout: 10000 },
    )
    .toBe(true)
  const workspace = (await events()).find((event) => event.type === "workspace.created" && event.scope.task === card.id)
  if (workspace?.type !== "workspace.created") throw new Error("Workspace was not created")
  await writeFile(path.join(workspace.payload.directory, "guide.txt"), "Reviewed guide\n")
  const git = async (...args: string[]) =>
    promisify(execFile)("git", args, { cwd: workspace.payload.directory, windowsHide: true })
  await git("add", ".")
  await git("commit", "-m", "Reviewed fixture")
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
  const click = async (label: string) => {
    const button = () =>
      [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)
    await expect.poll(button, { message: label }).toBeDefined()
    button()!.click()
  }
  try {
    await click("Inbox")
    await click("Review guide")
    await expect
      .poll(() => host.querySelector('[aria-label="Task review"]')?.textContent)
      .toContain("Feedback received")
    const diff = () => host.querySelector('[data-file="guide.txt"]')
    await expect.poll(() => diff()?.textContent, { timeout: 10000 }).toContain("Original guide")
    expect(diff()?.textContent).toContain("Reviewed guide")
    expect(
      host.querySelector('[aria-label="Worker report"]')!.compareDocumentPosition(diff()!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    const fill = (label: string, text: string) => {
      const field = host.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)!
      field.value = text
      field.dispatchEvent(new InputEvent("input", { bubbles: true }))
    }
    expect(host.querySelector<HTMLButtonElement>(".line-comment-add")).not.toBeNull()
    host.querySelector<HTMLButtonElement>(".line-comment-add")!.click()
    fill("Comment", "Keep the introduction")
    await click("Add")
    fill("Review feedback", "Add examples")
    await click("Request rework")
    await expect.poll(() => host.textContent, { timeout: 10000 }).toContain("worker started rework with your feedback")
    const revised = async () =>
      (await events()).filter((event) => event.type === "task.reported" && event.scope.task === card.id).at(-1)
    await expect
      .poll(
        async () =>
          (await events()).filter((event) => event.type === "task.reported" && event.scope.task === card.id).length,
        { timeout: 10000 },
      )
      .toBe(2)
    const report = await revised()
    if (report?.type !== "task.reported") throw new Error("Rework report is missing")
    expect(report.payload.claims![0]!.id).toBe(workspace.payload.claim)
    const sessionEvents = await connection.events.read({
      stream: `session:${report.payload.claims![0]!.session}`,
      from: 1,
    })
    expect(JSON.stringify(sessionEvents)).toContain("Add examples")
    expect(JSON.stringify(sessionEvents)).toContain("Keep the introduction")
    expect(JSON.stringify(sessionEvents)).toContain("guide.txt")
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Review feedback"]')?.value).toBe("")
    await click("Approve")
    await expect
      .poll(async () =>
        (await events()).some(
          (event) =>
            event.type === "task.reviewed" &&
            event.scope.task === card.id &&
            event.payload.lastReview?.decision === "approve",
        ),
      )
      .toBe(true)
    await expect.poll(() => host.textContent).toContain("Approved")
    await expect
      .poll(async () => (await events()).some((event) => event.type === "merge.done" && event.scope.task === card.id), {
        timeout: 10000,
      })
      .toBe(true)
    await connection.task.update({ task: card.id, human: localHuman, phase: "doing" })
    await writeFile(path.join(engine.project, "integration.txt"), "Integration check\n")
    await engine.git("add", "integration.txt")
    await engine.git("commit", "-m", "Integrated fixture")
    await connection.task.update({ task: card.id, human: localHuman, phase: "integrating" })
    await expect
      .poll(
        async () =>
          (await events()).some(
            (event) =>
              event.type === "phase.changed" && event.payload.id === card.id && event.payload.phase === "review",
          ),
        { timeout: 10000 },
      )
      .toBe(true)
    await expect.poll(() => host.querySelector('textarea[aria-label="Review feedback"]')).not.toBeNull()
    await expect
      .poll(() => host.querySelector('[data-file="integration.txt"]')?.textContent, { timeout: 10000 })
      .toContain("Integration check")
    fill("Review feedback", "Change the goal")
    await click("Return to planning")
    await expect
      .poll(async () =>
        (await events()).some(
          (event) =>
            event.type === "task.reviewed" &&
            event.payload.id === card.id &&
            event.payload.phase === "planning" &&
            event.payload.lastReview?.decision === "replan",
        ),
      )
      .toBe(true)
    await expect.poll(() => host.textContent).toContain("Returned to planning")
  } finally {
    dispose()
    host.remove()
  }
})

test("keeps a submitted decision on its original task while switching reviews", async () => {
  const connection = await client()
  const group = await createGroup()
  const first = await connection.task.create({
    group: group.id,
    human: localHuman,
    title: "First review",
    member: "worker",
    workspace: "folder",
    review: true,
  })
  const second = await connection.task.create({
    group: group.id,
    human: localHuman,
    title: "Second review",
    member: "worker",
    workspace: "folder",
    review: true,
  })
  const events = async () =>
    (await connection.events.read({ stream: `group:${group.id}`, from: 1 }))!.map((event) =>
      EngineEventSchema.parse(event),
    )
  await expect
    .poll(async () => (await events()).filter((event) => event.type === "task.reported").length, { timeout: 10000 })
    .toBe(2)
  const reports = (await events()).flatMap((event) => (event.type === "task.reported" ? [event.payload] : []))
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => {
    const [selected, select] = createSignal(reports.find((card) => card.id === first.id)!)
    return (
      <>
        <TaskReview card={selected()} events={[]} members={[]} onBack={() => {}} />
        <button onClick={() => select(reports.find((card) => card.id === second.id)!)}>Next review</button>
      </>
    )
  }, host)
  const fill = (text: string) => {
    const field = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Review feedback"]')!
    field.value = text
    field.dispatchEvent(new InputEvent("input", { bubbles: true }))
  }
  try {
    fill("Revise the first task")
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")]
    buttons.find((button) => button.textContent === "Request rework")!.click()
    buttons.find((button) => button.textContent === "Next review")!.click()
    fill("Revise the first task")
    await expect
      .poll(async () => (await events()).flatMap((event) => (event.type === "task.reviewed" ? [event.payload.id] : [])))
      .toEqual([first.id])
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Review feedback"]')?.value).toBe(
      "Revise the first task",
    )
  } finally {
    dispose()
    host.remove()
  }
})

test("a claim's file tree scrolls only its own diff when claims share a path", async () => {
  const connection = await client()
  const group = await createGroup()
  for (const title of ["First claim", "Second claim"])
    await connection.task.create({ group: group.id, human: localHuman, title, member: "worker", review: true })
  const events = async () =>
    (await connection.events.read({ stream: `group:${group.id}`, from: 1 }))!.map((event) =>
      EngineEventSchema.parse(event),
    )
  await expect
    .poll(async () => (await events()).filter((event) => event.type === "task.reported").length, { timeout: 10000 })
    .toBe(2)
  const facts = await events()
  const reports = facts.flatMap((event) => (event.type === "task.reported" ? [event.payload] : []))
  for (const event of facts)
    if (event.type === "workspace.created")
      await writeFile(path.join(event.payload.directory, "guide.txt"), `Revision for ${event.payload.claim}\n`)
  const goal = { ...reports[0]!, id: "review-goal", phase: "doing", claims: [] }
  const cards = [goal, ...reports.map((card) => ({ ...card, parent: goal.id }))]
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(
    () => <TaskReview card={goal} cards={cards} events={facts} members={[]} onBack={() => {}} />,
    host,
  )
  try {
    await expect
      .poll(() => host.querySelectorAll('[data-file="guide.txt"] .line.add').length, { timeout: 10000 })
      .toBe(2)
    const files = [...host.querySelectorAll<HTMLElement>('[data-file="guide.txt"]')]
    const scrolled: HTMLElement[] = []
    for (const file of files)
      file.scrollIntoView = () => {
        scrolled.push(file)
      }
    host.querySelector<HTMLButtonElement>(".task-review-diff .rt-file")!.click()
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    expect(scrolled).toEqual([files[0]])
  } finally {
    dispose()
    host.remove()
  }
})
