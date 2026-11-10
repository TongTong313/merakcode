import { readFile } from "node:fs/promises"
import { expect, test } from "vitest"
import { EngineEventSchema } from "../protocol.gen"
import { createConversation, foldConversation } from "./conversation"
import { foldSession } from "./session"

test("restores unanswered permission from a snapshot before subscribing to new events", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("../../../../schema/testdata/session.json", import.meta.url), "utf8"),
  )
  const request = EngineEventSchema.parse({
    id: "pending",
    type: "permission.requested",
    stream: "session:golden",
    seq: fixture.state.lastSeq + 1,
    scope: { session: "golden" },
    actor: { kind: "agent" },
    time: "2026-11-08T00:00:00Z",
    payload: {
      call: { id: "call", name: "bash", input: { command: "custom-check" } },
      spec: { name: "bash", description: "Command", input: {}, effect: "exec" },
    },
  })
  const snapshot = foldSession(fixture.state, request)
  expect(snapshot).toBeDefined()
  const restored = createConversation(snapshot!)
  expect(restored.permissions.pending?.id).toBe("pending")
  const reply = EngineEventSchema.parse({
    ...request,
    id: "answer",
    type: "permission.replied",
    cause: request.id,
    seq: request.seq! + 1,
    payload: { decision: "allow" },
  })
  expect(createConversation(foldSession(snapshot, reply)!).permissions).toEqual({})
})

test("shows delegated permission only after escalation and keeps the original request ID", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("../../../../schema/testdata/session.json", import.meta.url), "utf8"),
  )
  let view = createConversation(fixture.state)
  const payload = {
    member: "worker",
    leader: "leader",
    mode: "auto",
    call: { id: "call", name: "bash", input: { command: "custom-check" } },
    spec: { name: "bash", effect: "exec", description: "Run a command", input: {} },
  }
  const fact = (type: string, body: unknown, id: string, cause?: string) =>
    EngineEventSchema.parse({
      type,
      payload: body,
      id,
      cause,
      stream: "session:golden",
      scope: { session: "golden" },
      actor: { kind: "agent" },
      time: "2026-11-08T00:00:00Z",
      seq: view.state.lastSeq + 1,
    })
  view = foldConversation(view, fact("permission.requested", payload, "approval"))
  expect(Object.keys(view.permissions)).toHaveLength(0)
  view = foldConversation(
    view,
    fact("permission.escalated", { ...payload, leader: undefined, id: "approval" }, "escalation", "approval"),
  )
  expect(view.permissions.approval?.id).toBe("approval")
  view = foldConversation(view, fact("permission.replied", { decision: "allow", human: "owner" }, "reply", "approval"))
  expect(Object.keys(view.permissions)).toHaveLength(0)
})

test("keeps workspace confirmations and MCP diagnostics after a turn ends", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("../../../../schema/testdata/session.json", import.meta.url), "utf8"),
  )
  let view = createConversation(fixture.state)
  const apply = (type: string, payload: unknown, id: string) => {
    view = foldConversation(
      view,
      EngineEventSchema.parse({
        type,
        payload,
        id,
        stream: "session:golden",
        scope: { session: "golden" },
        actor: { kind: "agent" },
        time: "2026-11-08T00:00:00Z",
        seq: view.state.lastSeq + 1,
      }),
    )
  }
  apply(
    "permission.requested",
    {
      kind: "workspace",
      call: { id: "call", name: "workspace_mcp", input: {} },
      spec: { name: "workspace_mcp", description: "Confirm", effect: "exec", input: {} },
    },
    "trust",
  )
  apply("session.warning", { code: "MRK-5010", server: "docs" }, "warning")
  apply(
    "turn.finished",
    {
      stop: "answered",
      final: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: false },
    },
    "finished",
  )
  expect(view.permissions.trust?.payload.kind).toBe("workspace")
  const restored = createConversation(view.state)
  expect(restored.permissions.trust?.payload.kind).toBe("workspace")
  expect(restored.state.warnings).toEqual([{ code: "MRK-5010", server: "docs" }])
})

test("shows streamed text and replaces it with the durable completion", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("../../../../schema/testdata/session.json", import.meta.url), "utf8"),
  )
  const events = (fixture.events as unknown[]).map((value) => EngineEventSchema.parse(value))
  const created = events[0]!
  if (created.type !== "session.created") throw new Error("Missing creation")
  let view = createConversation({ ...created.payload, lastSeq: created.seq!, scope: created.scope })
  let streamed = false
  for (const event of events.slice(1)) {
    const previous = view
    view = foldConversation(view, event)
    if (event.type === "message.delta" && event.payload.kind === "text") {
      streamed = true
      expect(view.live?.parts.map((part) => part.text ?? "").join("")).toBe("The note is ready.")
      expect(previous.live).not.toEqual(view.live)
    }
    if (event.type === "message.completed") expect(view.live).toBeUndefined()
  }
  expect(streamed).toBe(true)
  expect(view.state).toEqual(fixture.state)
  expect(view.tools["read-note"]).toMatchObject({
    name: "read_file",
    status: "completed",
    parts: [{ text: "A note from the workspace." }],
  })
  expect(view.tools["read-note"]?.startedAt).toBe(events.find((event) => event.type === "tool.called")?.time)
  expect(view.tools["read-note"]?.endedAt).toBe(events.find((event) => event.type === "tool.completed")?.time)
  expect(createConversation(view.state).tools["read-note"]).toMatchObject({ name: "read_file", status: "completed" })
})

test("folds a question and its answer without confusing another request", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("../../../../schema/testdata/session.json", import.meta.url), "utf8"),
  )
  let view = createConversation(fixture.state)
  const fact = (type: string, payload: unknown, id: string, cause?: string) =>
    EngineEventSchema.parse({
      type,
      payload,
      id,
      cause,
      stream: "session:golden",
      scope: { session: "golden" },
      actor: { kind: "agent" },
      time: "2026-11-08T00:00:00Z",
      seq: view.state.lastSeq + 1,
    })
  view = foldConversation(view, fact("question.asked", { text: "Choose", options: ["Blue"] }, "ask"))
  expect(view.questions.ask?.payload.text).toBe("Choose")
  const before = view
  view = foldConversation(view, fact("question.answered", { text: "Blue" }, "reply", "ask"))
  expect(Object.keys(view.questions)).toHaveLength(0)
  expect(before.questions.ask?.payload.text).toBe("Choose")
})

test("a buffered completion clears replayed deltas without duplicating snapshot messages", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("../../../../schema/testdata/session.json", import.meta.url), "utf8"),
  )
  const events = (fixture.events as unknown[]).map((value) => EngineEventSchema.parse(value))
  const completion = events.findLast((event) => event.type === "message.completed")!
  const delta = events.findLast((event) => event.type === "message.delta" && event.payload.kind === "text")!
  const snapshot = { ...fixture.state, lastSeq: completion.seq, status: "running" }
  const streamed = foldConversation(createConversation(snapshot), delta)
  expect(streamed.live).toBeDefined()
  const restored = foldConversation(streamed, completion)
  expect(restored.state.messages).toEqual(snapshot.messages)
  expect(restored.live).toBeUndefined()
})
