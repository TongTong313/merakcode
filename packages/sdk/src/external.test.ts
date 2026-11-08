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
