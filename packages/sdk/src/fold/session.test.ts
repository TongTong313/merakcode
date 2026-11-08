import { expect, test } from "vitest"
import { readFile } from "node:fs/promises"
import { EngineEventSchema, SessionStateSchema, type SessionState } from "../protocol.gen"
import { foldSession } from "./session"

test("folds the real Go event log into the same session snapshot", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("../../../../schema/testdata/session.json", import.meta.url), "utf8"),
  )
  const events = fixture.events.map((event: unknown) => EngineEventSchema.parse(event))
  let state: SessionState | undefined
  for (const event of events) state = foldSession(state, event)
  expect(state).toEqual(SessionStateSchema.parse(fixture.state))
  for (const event of events) state = foldSession(state, event)
  expect(state).toEqual(SessionStateSchema.parse(fixture.state))
})

test("rebuilds the old prefix and removes retained reasoning without changing earlier snapshots", () => {
  const previous: SessionState = {
    id: "session",
    lastSeq: 4,
    scope: { session: "session" },
    status: "done",
    config: { provider: "fake", model: "model", workdir: "/workspace" },
    system: "Frozen",
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: false },
    messages: [
      { role: "user", parts: [{ text: "Earlier question" }] },
      { role: "assistant", parts: [{ text: "Earlier answer" }] },
      { role: "user", parts: [{ text: "Continue" }] },
      {
        role: "assistant",
        parts: [{ reasoning: { provider: "fake", text: "Recent thought" } }, { text: "Recent answer" }],
      },
    ],
  }
  const next = foldSession(previous, {
    id: "rebuild",
    seq: 5,
    stream: "session:session",
    time: "2026-11-08T00:00:00Z",
    actor: { kind: "agent" },
    scope: { session: "session" },
    type: "session.rebuilt",
    payload: {
      from: 0,
      to: 2,
      throughSeq: 4,
      summaryId: "summary",
      summary: { role: "user", parts: [{ text: "Summary" }] },
      usage: { input: 8, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: false },
    },
  })!
  expect(next.messages).toEqual([
    { role: "user", parts: [{ text: "Summary" }] },
    { role: "user", parts: [{ text: "Continue" }] },
    { role: "assistant", parts: [{ text: "Recent answer" }] },
  ])
  expect(next.summaryId).toBe("summary")
  expect(next.usage.input).toBe(18)
  expect(next.usage.output).toBe(5)
  expect(previous.messages?.[3]?.parts?.[0]?.reasoning?.text).toBe("Recent thought")
})

test("restores child reports, loaded tools, usage and the model selected for a turn", () => {
  const created = EngineEventSchema.parse({
    id: "created",
    seq: 1,
    stream: "session:s",
    time: "2026-11-08T00:00:00Z",
    actor: { kind: "human" },
    scope: { session: "s" },
    type: "session.created",
    payload: {
      id: "s",
      scope: {},
      config: { provider: "fake", model: "first", workdir: "/workspace" },
      system: "",
      lastSeq: 0,
      status: "idle",
      messages: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: false },
    },
  })
  let state = foldSession(undefined, created)!
  const apply = (type: string, payload: unknown) => {
    state = foldSession(
      state,
      EngineEventSchema.parse({ ...created, id: `event-${state.lastSeq + 1}`, seq: state.lastSeq + 1, type, payload }),
    )!
  }
  apply("turn.started", { selection: { provider: "relay", model: "second", thinking: "high" } })
  apply("child.started", { id: "child" })
  const before = state
  apply("child.finished", { id: "child", stop: "answered", report: [{ text: "Found it" }] })
  apply("child.finished", { id: "child", stop: "answered", report: [{ text: "Found it" }] })
  apply("tool.completed", {
    name: "load_tools",
    callId: "load",
    parts: [
      { text: JSON.stringify([{ name: "search", description: "Search", effect: "read", input: { type: "object" } }]) },
    ],
  })
  apply("memory.extracted", {
    stored: 1,
    usage: { input: 11, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: false },
  })
  expect(state.config).toMatchObject({ provider: "relay", model: "second", thinking: "high" })
  expect(state.messages?.filter((message) => message.role === "user")).toEqual([
    { role: "user", parts: [{ text: "Child child report (answered):" }, { text: "Found it" }] },
  ])
  expect(before.children?.child?.delivered).toBe(false)
  expect(state.children?.child?.delivered).toBe(true)
  expect(state.loaded).toEqual(["search"])
  expect(state.usage.input).toBe(11)
})
