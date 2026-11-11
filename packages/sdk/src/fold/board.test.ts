import { expect, test } from "vitest"
import { applyToBoard, emptyBoard, type EngineEvent, type TaskCard } from "../index"

const card: TaskCard = {
  id: "goal",
  group: "group",
  title: "Deliver the guide",
  description: "Write the user guide",
  acceptance: ["Examples are verified"],
  priority: 0,
  status: "open",
  claims: [],
  createdBy: { kind: "human", id: "owner" },
}

function taskEvent(seq: number, value: TaskCard): Extract<EngineEvent, { type: "task.updated" }> {
  return {
    id: `event-${seq}`,
    stream: "group:group",
    seq,
    time: "2026-11-08T00:00:00Z",
    actor: { kind: "agent", id: "leader" },
    scope: { group: "group", task: value.id },
    type: "task.updated",
    payload: value,
  }
}

test("folds remote progress without changing the host group cursor", () => {
  const initial = applyToBoard(emptyBoard(), taskEvent(1, card))
  const progress: EngineEvent = {
    ...taskEvent(9, card),
    id: "remote-progress",
    stream: "device:remote:connection:group:group",
    type: "task.progress",
    payload: { claim: "claim", summary: "Checked remotely" },
  }
  const current = applyToBoard(initial, progress)
  expect(current.columns.open[0]?.progress).toEqual({ claim: "Checked remotely" })
  expect(current.lastSeq).toBe(1)
  expect(applyToBoard(current, progress)).toBe(current)
  expect(applyToBoard(current, taskEvent(2, { ...card, status: "review" })).columns.review[0]?.progress).toEqual({
    claim: "Checked remotely",
  })
})

test("replays task columns and goal rows without changing previous snapshots", () => {
  const initial = emptyBoard()
  const opened = applyToBoard(initial, taskEvent(1, card))
  const child: TaskCard = { ...card, id: "child", parent: "goal", title: "Verify examples", status: "queued" }
  const queued = applyToBoard(opened, taskEvent(2, child))
  const running = applyToBoard(
    queued,
    taskEvent(3, {
      ...child,
      status: "running",
      claims: [{ id: "claim", task: "child", member: "writer", role: "owner", status: "active", session: "run" }],
    }),
  )
  expect(initial.columns.open).toEqual([])
  expect(opened.columns.open).toEqual([card])
  expect(queued.columns.queued).toEqual([child])
  expect(running.columns.queued).toEqual([])
  expect(running.columns.running[0]?.claims?.[0]?.member).toBe("writer")
  expect(running.goals).toEqual([{ id: "goal", title: "Deliver the guide", status: "open", owner: "owner" }])
  expect(running.lastSeq).toBe(3)
  expect(applyToBoard(running, taskEvent(2, child))).toBe(running)
  expect(() => applyToBoard(running, taskEvent(5, child))).toThrow("sequence gap")
  expect(applyToBoard(running, { ...taskEvent(4, child), stream: "session:run" })).toBe(running)
})

test("updates the top-level goal phase from a persisted phase change", () => {
  const initial = applyToBoard(emptyBoard(), taskEvent(1, { ...card, phase: "planning" }))
  const next = applyToBoard(initial, {
    ...taskEvent(2, card),
    type: "phase.changed",
    payload: { ...card, phase: "doing" },
  })
  expect(initial.goals[0]?.phase).toBe("planning")
  expect(next.goals[0]?.phase).toBe("doing")
  expect(next.columns.open[0]?.phase).toBe("doing")
})

test("clears the previous decision when a new review snapshot omits it", () => {
  const approved = applyToBoard(
    emptyBoard(),
    taskEvent(1, {
      ...card,
      status: "review",
      lastReview: { human: "owner", phase: "review", decision: "approve" },
    }),
  )
  const next = applyToBoard(approved, {
    ...taskEvent(2, { ...card, phase: "review", status: "review" }),
    type: "phase.changed",
  })
  expect(next.columns.review[0]?.lastReview).toBeUndefined()
  expect(approved.columns.review[0]?.lastReview?.decision).toBe("approve")
})

test("retains progress, queue positions, integration results and published artifacts", () => {
  const first: TaskCard = {
    ...card,
    id: "first",
    status: "queued",
    claims: [{ id: "one", member: "writer", task: "first", role: "owner", status: "queued" }],
  }
  const second: TaskCard = {
    ...card,
    id: "second",
    status: "queued",
    priority: 2,
    claims: [{ id: "two", member: "writer", task: "second", role: "owner", status: "queued" }],
  }
  const queued = applyToBoard(applyToBoard(emptyBoard(), taskEvent(1, first)), taskEvent(2, second))
  expect(queued.columns.queued.find((item) => item.id === "second")?.queue).toEqual({ two: 1 })
  expect(queued.columns.queued.find((item) => item.id === "first")?.queue).toEqual({ one: 2 })
  const running = applyToBoard(
    queued,
    taskEvent(3, {
      ...second,
      status: "running",
      claims: [{ ...second.claims![0]!, status: "active", session: "session" }],
    }),
  )
  expect(running.columns.queued[0]?.queue).toEqual({ one: 1 })
  const progress = applyToBoard(running, {
    ...taskEvent(4, second),
    type: "task.progress",
    payload: { claim: "two", summary: "Examples checked" },
  })
  expect(progress.columns.running[0]?.progress).toEqual({ two: "Examples checked" })
  expect(running.columns.running[0]?.progress).toBeUndefined()
  const merged = applyToBoard(progress, {
    ...taskEvent(5, second),
    type: "merge.conflicted",
    payload: { workspace: "workspace", claim: "two", target: "main", conflicts: ["guide.md"] },
  })
  expect(merged.columns.running[0]?.merges?.two).toMatchObject({ status: "conflicted", conflicts: ["guide.md"] })
  const published = applyToBoard(merged, {
    ...taskEvent(6, second),
    type: "artifact.published",
    payload: {
      id: "artifact",
      workspace: "workspace",
      claim: "two",
      path: "guide.md",
      title: "Guide",
      mediaType: "text/markdown",
    },
  })
  expect(published.columns.running[0]?.artifacts?.map((item) => item.id)).toEqual(["artifact"])
  const updated = applyToBoard(published, taskEvent(7, { ...second, status: "review" }))
  expect(updated.columns.review[0]?.progress).toEqual({ two: "Examples checked" })
  expect(queued.columns.queued.find((item) => item.id === "first")?.queue).toEqual({ one: 2 })
})
