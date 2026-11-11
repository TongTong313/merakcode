import { expect, test } from "vitest"
import { applyToInbox, emptyInbox, type EngineEvent } from "../index"

function notice(seq: number, kind: string, to: string[], cause?: string): EngineEvent {
  return {
    id: `notice-${seq}`,
    stream: "group:group",
    seq,
    time: "2026-11-08T00:00:00Z",
    actor: { kind: "agent" },
    scope: { group: "group", task: "task" },
    type: "notice.sent",
    cause,
    payload: { kind, to, text: "A decision is needed" },
  }
}

test("ignores old checkpoint notices after review and accepts a later review", () => {
  const card = {
    id: "task",
    group: "group",
    project: "/work/project",
    title: "Task",
    description: "",
    acceptance: [],
    claims: [],
    priority: 0,
    status: "review",
    phase: "review",
    createdBy: { kind: "human", id: "me" },
  }
  const reviewed: EngineEvent = { ...notice(1, "info", ["me"]), type: "task.reviewed", payload: card }
  let inbox = applyToInbox(emptyInbox(), reviewed, "me")
  inbox = applyToInbox(inbox, { ...notice(8, "review", ["me"], "old-review"), stream: "inbox:account" }, "me")
  expect(inbox.todo).toEqual([])
  inbox = applyToInbox(
    inbox,
    { ...notice(2, "info", ["me"]), id: "new-review", type: "phase.changed", payload: card },
    "me",
  )
  inbox = applyToInbox(inbox, { ...notice(9, "review", ["me"], "old-review"), stream: "inbox:account" }, "me")
  expect(inbox.todo).toEqual([])
  inbox = applyToInbox(inbox, { ...notice(10, "review", ["me"], "new-review"), stream: "inbox:account" }, "me")
  expect(inbox.todo.map((item) => item.request)).toEqual(["new-review"])
})

test("folds device inbox notices without consuming the group sequence or restoring answered requests", () => {
  const delivered: EngineEvent = { ...notice(7, "permission", ["me"], "request"), stream: "inbox:account" }
  const pending = applyToInbox(emptyInbox(), delivered, "me")
  expect(pending.todo.map((item) => item.request)).toEqual(["request"])
  expect(pending.lastSeq).toBe(0)
  const answered = applyToInbox(
    pending,
    {
      ...notice(1, "info", ["me"]),
      id: "reply",
      cause: "request",
      type: "permission.replied",
      payload: { decision: "allow" },
    },
    "me",
  )
  expect(answered.todo).toEqual([])
  expect(applyToInbox(answered, delivered, "me").todo).toEqual([])
  expect(applyToInbox(answered, { ...delivered, id: "late-copy", seq: 8 }, "me").todo).toEqual([])
})

test("shows only my notices and removes answered requests while retaining information", () => {
  const initial = emptyInbox()
  const asked = applyToInbox(initial, notice(1, "permission", ["me"], "request"), "me")
  const unrelated = applyToInbox(asked, notice(2, "question", ["someone-else"], "other"), "me")
  const informed = applyToInbox(unrelated, notice(3, "info", ["me"]), "me")
  const answer: EngineEvent = {
    id: "answer",
    stream: "group:group",
    seq: 4,
    time: "2026-11-08T00:00:01Z",
    actor: { kind: "human", id: "me" },
    scope: { group: "group", task: "task" },
    type: "permission.replied",
    cause: "request",
    payload: { decision: "allow" },
  }
  const answered = applyToInbox(informed, answer, "me")
  expect(initial.todo).toEqual([])
  expect(asked.todo.map((item) => item.id)).toEqual(["notice-1"])
  expect(unrelated.todo).toEqual(asked.todo)
  expect(informed.info.map((item) => item.id)).toEqual(["notice-3"])
  expect(answered.todo).toEqual([])
  expect(answered.info).toEqual(informed.info)
  expect(answered.lastSeq).toBe(4)
  expect(applyToInbox(answered, notice(1, "permission", ["me"], "request"), "me")).toBe(answered)
  expect(() => applyToInbox(answered, notice(6, "info", ["me"]), "me")).toThrow("sequence gap")
})

test("replaces review reminders and clears obsolete checkpoints when the phase changes", () => {
  const initial = applyToInbox(emptyInbox(), notice(1, "review", ["me"], "first-report"), "me")
  const reminded = applyToInbox(initial, notice(2, "review", ["me"], "integrated-goal"), "me")
  expect(reminded.todo.map((item) => item.request)).toEqual(["integrated-goal"])
  const asked = applyToInbox(reminded, notice(3, "question", ["me"], "question"), "me")
  const replanned = applyToInbox(
    asked,
    {
      ...notice(4, "info", ["me"]),
      type: "phase.changed",
      payload: {
        id: "task",
        group: "group",
        project: "/work/project",
        title: "Replan",
        description: "",
        acceptance: [],
        claims: [],
        priority: 0,
        status: "open",
        phase: "planning",
        createdBy: { kind: "human", id: "me" },
      },
    },
    "me",
  )
  expect(replanned.todo.map((item) => item.kind)).toEqual(["question"])
  expect(initial.todo.map((item) => item.request)).toEqual(["first-report"])
})
