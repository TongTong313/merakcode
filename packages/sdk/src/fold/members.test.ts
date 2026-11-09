import { expect, test } from "vitest"
import { applyToMembers, type EngineEvent, type GroupMember } from "../index"

test("replays accepted hosts and sandbox availability without changing earlier member snapshots", () => {
  const worker: GroupMember = {
    id: "worker",
    group: "group",
    name: "Worker",
    kind: "agent",
    agentRole: "worker",
    status: "idle",
    hosts: ["models.example.com"],
  }
  const added: Extract<EngineEvent, { type: "member.added" }> = {
    id: "added",
    stream: "group:group",
    seq: 1,
    time: "2026-11-09T00:00:00Z",
    scope: { group: "group" },
    actor: { kind: "human", id: "owner" },
    type: "member.added",
    payload: worker,
  }
  const members = applyToMembers([], added)
  const updated: Extract<EngineEvent, { type: "member.updated" }> = {
    ...added,
    id: "updated",
    seq: 2,
    type: "member.updated",
    payload: { ...worker, hosts: ["models.example.com", "gateway.example.com"], unconfined: true },
  }
  const next = applyToMembers(members, updated)
  expect(next).toEqual([{ ...worker, hosts: ["models.example.com", "gateway.example.com"], unconfined: true }])
  expect(members).toEqual([worker])
  const restored = applyToMembers(next, { ...updated, id: "restored", seq: 3, payload: worker })
  expect(restored[0]?.unconfined).toBeUndefined()
  expect(applyToMembers(next, { ...updated, payload: { ...worker, id: "unknown" } })).toEqual(next)
})
