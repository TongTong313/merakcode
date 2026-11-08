import { render } from "solid-js/web"
import { emptyBoard, type BoardCard } from "@merakcode/sdk"
import { expect, test } from "vitest"
import { setLocale } from "../../i18n"
import { TaskBoard } from "./board"

test("opens a board card's structured report and shows the goal phase", async () => {
  setLocale("en")
  const card: BoardCard = {
    id: "task",
    group: "group",
    title: "Update the guide",
    description: "Document the new behavior.",
    acceptance: ["Examples pass"],
    createdBy: { kind: "human", id: "owner" },
    priority: 0,
    status: "review",
    phase: "review",
    review: true,
    claims: [
      {
        id: "claim",
        member: "worker",
        task: "task",
        role: "owner",
        status: "reported",
        report: {
          claim: "claim",
          verdict: "done",
          summary: "Updated and checked the guide.",
          changes: [{ path: "guide.md", kind: "modified", added: 3, removed: 0 }],
          usage: { input: 17, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: false },
        },
      },
    ],
  }
  const board = emptyBoard()
  board.columns.review.push(card)
  board.goals.push({ id: "task", title: "Update the guide", status: "review", phase: "review", owner: "owner" })
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(
    () => (
      <TaskBoard
        group={{
          id: "group",
          kind: "local",
          name: "Delivery",
          project: { directory: "/project" },
          defaultLeader: "leader",
        }}
        board={board}
        members={[{ id: "worker", group: "group", kind: "agent", name: "Writer", agentRole: "worker", status: "idle" }]}
      />
    ),
    host,
  )
  try {
    expect(host.querySelector('[aria-label="Goals"]')?.textContent).toContain("Review")
    const column = host.querySelector('[aria-label="Review tasks"]')!
    expect(column.textContent).toContain("Update the guide")
    column.querySelector<HTMLButtonElement>("button")!.click()
    await expect
      .poll(() => document.querySelector('[role="dialog"]')?.textContent)
      .toContain("Updated and checked the guide.")
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain("Writer")
    expect(dialog.textContent).toContain("Examples pass")
    expect(dialog.querySelector('table[aria-label="File changes"]')?.textContent).toContain("guide.md")
  } finally {
    dispose()
    host.remove()
  }
})
