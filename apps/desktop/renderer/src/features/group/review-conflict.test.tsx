import { emptyBoard, type BoardCard, type EngineEvent } from "@merakcode/sdk"
import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import { expect, test } from "vitest"
import { setLocale } from "../../i18n"
import { TaskBoard } from "./board"
import { TaskReview } from "./review"

test.each([
  ["./docs//report.txt", "docs/report.txt", true],
  ["docs/../report.txt", "report.txt", true],
  ["report.txt", "other.txt", false],
])("recognizes published artifact %s as %s", (declared, stored, available) => {
  setLocale("en")
  const card: BoardCard = {
    id: "task",
    group: "group",
    title: "Review report",
    description: "",
    acceptance: [],
    priority: 0,
    status: "review",
    workspace: "folder",
    createdBy: { kind: "human", id: "owner" },
    claims: [
      {
        id: "claim",
        task: "task",
        member: "writer",
        role: "owner",
        status: "reported",
        published: ["blob"],
        report: {
          claim: "claim",
          verdict: "done",
          summary: "Ready",
          artifacts: [{ path: declared, title: "Report" }],
          usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: false },
        },
      },
    ],
    artifacts: [{ id: "blob", workspace: "workspace", claim: "claim", path: `blob/${stored}`, title: "Report" }],
  }
  const host = document.createElement("div")
  const dispose = render(() => <TaskReview card={card} events={[]} members={[]} onBack={() => {}} />, host)
  try {
    const approve = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Approve",
    )!
    expect(approve.disabled).toBe(!available)
    expect(host.textContent?.includes("Download Report")).toBe(available)
  } finally {
    dispose()
  }
})

test("opens an integration task from its conflict badge and lists conflicting paths", async () => {
  setLocale("en")
  const original: BoardCard = {
    id: "original",
    group: "group",
    title: "Update guide",
    description: "",
    acceptance: [],
    priority: 0,
    status: "review",
    claims: [],
    createdBy: { kind: "human", id: "owner" },
    merges: {
      claim: {
        claim: "claim",
        workspace: "workspace",
        target: "main",
        status: "conflicted",
        conflicts: ["guide.md", "examples.ts"],
      },
    },
  }
  const integration: BoardCard = {
    ...original,
    id: "integration",
    title: "Integrate guide",
    parent: "original",
    integrationOf: "claim",
    merges: undefined,
  }
  const cards = [original, integration]
  const board = emptyBoard()
  board.columns.review = cards
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => {
    const [selected, select] = createSignal("")
    return (
      <Show
        when={selected()}
        fallback={
          <TaskBoard
            group={{
              id: "group",
              kind: "local",
              name: "Delivery",
              project: { directory: "/project" },
              defaultLeader: "leader",
            }}
            board={board}
            members={[]}
            onReview={select}
          />
        }
      >
        <TaskReview card={integration} cards={cards} events={[]} members={[]} onBack={() => select("")} />
      </Show>
    )
  }, host)
  try {
    const button = [...host.querySelectorAll<HTMLButtonElement>(".task-card")].find((item) =>
      item.textContent?.includes("Integrate guide"),
    )!
    expect(button.textContent).toContain("Integration conflict")
    button.click()
    const review = () =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
        (item) => item.textContent?.trim() === "Review task",
      )
    await expect.poll(review).toBeDefined()
    review()!.click()
    await expect.poll(() => host.querySelector('[aria-label="Conflicting files"]')?.textContent).toContain("guide.md")
    expect(host.querySelector('[aria-label="Conflicting files"]')?.textContent).toContain("examples.ts")
  } finally {
    dispose()
    host.remove()
  }
})

test("retains descendant reports after delivery without reading a released workspace", () => {
  setLocale("en")
  const goal: BoardCard = {
    id: "goal",
    group: "group",
    title: "Deliver guide",
    description: "",
    acceptance: [],
    priority: 0,
    status: "done",
    phase: "done",
    claims: [],
    createdBy: { kind: "human", id: "owner" },
  }
  const child: BoardCard = {
    ...goal,
    id: "child",
    parent: "goal",
    title: "Write guide",
    phase: undefined,
    base: "baseline",
    claims: [
      {
        id: "claim",
        task: "child",
        member: "writer",
        role: "owner",
        status: "reported",
        workspace: "workspace",
        report: {
          claim: "claim",
          verdict: "done",
          summary: "Child guide checked",
          usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: false },
        },
      },
    ],
  }
  const released: EngineEvent = {
    id: "released",
    stream: "group:group",
    seq: 1,
    time: "2026-11-09T00:00:00Z",
    actor: { kind: "system" },
    scope: { group: "group", task: "child" },
    type: "workspace.released",
    payload: {
      id: "workspace",
      group: "group",
      task: "child",
      claim: "claim",
      member: "writer",
      kind: "worktree",
      base: "baseline",
      branch: "claim",
      directory: "/released",
      project: "/project",
      active: false,
      released: true,
    },
  }
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(
    () => <TaskReview card={goal} cards={[goal, child]} events={[released]} members={[]} onBack={() => {}} />,
    host,
  )
  try {
    expect(host.querySelector('[aria-label="Worker report"]')?.textContent).toContain("Child guide checked")
    expect(host.textContent).toContain("This workspace has been released")
    expect(host.querySelector(".task-review-diff")).toBeNull()
  } finally {
    dispose()
    host.remove()
  }
})
