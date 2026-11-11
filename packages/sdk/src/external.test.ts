import { expect, test } from "vitest"
import { EngineEventSchema } from "./protocol.gen"

test("accepts external event names and keeps engine payload validation strict", () => {
  const envelope = {
    id: "external-event",
    stream: "group:group",
    seq: 2,
    time: "2026-11-09T00:00:00Z",
    scope: { group: "group" },
    actor: { kind: "external" },
    type: "external.ci.finished",
    payload: { status: "success", paths: ["docs/guide.md"] },
  }
  expect(EngineEventSchema.parse(envelope)).toEqual(envelope)
  for (const type of [
    "external.",
    "external.ci finished",
    "external.ci\u00a0done",
    "external.ci\vdone",
    "external.ci\u0085done",
    "external.ci\ufeffdone",
    "unexpected.event",
    "task.reported",
  ])
    expect(EngineEventSchema.safeParse({ ...envelope, type }).success).toBe(false)
  expect(EngineEventSchema.safeParse({ ...envelope, payload: null }).success).toBe(false)
})

test("validates the events that move a task between its own stream, a group and the archive", () => {
  const card = {
    id: "task",
    project: "/work/project",
    title: "Written alone",
    priority: 0,
    description: "",
    acceptance: [],
    status: "open",
    claims: [],
    createdBy: { kind: "human", id: "owner" },
  }
  const envelope = { id: "event", seq: 1, time: "2026-11-11T00:00:00Z", actor: { kind: "system", id: "system" } }
  const created = { ...envelope, stream: "task:task", scope: { task: "task" }, type: "task.created", payload: card }
  const bound = {
    ...envelope,
    stream: "group:group",
    scope: { group: "group", task: "task" },
    type: "task.bound",
    payload: { ...card, group: "group" },
  }
  const archived = { ...bound, type: "task.archived", payload: { ...card, group: "group", archived: true } }
  for (const fact of [created, bound, archived]) expect(EngineEventSchema.parse(fact)).toEqual(fact)
  expect(EngineEventSchema.safeParse({ ...created, payload: { ...card, project: undefined } }).success).toBe(false)
})
