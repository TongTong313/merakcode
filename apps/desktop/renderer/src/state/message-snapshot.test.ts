import type { Event, MessageOutput, PartOutput, SessionOutput } from "@merakcode/sdk/client"
import { applyEvent, createSessionsState } from "@merakcode/sdk/store"
import { expect, test } from "vitest"
import { MessageSnapshot } from "./message-snapshot"

const info = { id: "message", sessionID: "session", role: "assistant", time: { created: 1 } } as MessageOutput
const text: PartOutput = { id: "text", messageID: info.id, sessionID: info.sessionID, type: "text", text: "old" }
const history = () => [{ info: structuredClone(info), parts: [structuredClone(text)] }]

test("a late history response preserves completed parts and fills unrelated history", () => {
  const state = createSessionsState()
  const snapshot = new MessageSnapshot(info.sessionID)
  const updated: Event = {
    type: "message.part.updated",
    properties: { part: { ...text, text: "completed reply" } },
  }
  snapshot.observe(updated)
  applyEvent(state, updated)
  snapshot.apply(state, history())
  expect(state.message[info.sessionID]).toEqual([info])
  expect(state.part[info.id]).toEqual([{ ...text, text: "completed reply" }])
})

test("a streamed full part with a delta is neither overwritten nor replayed", () => {
  const state = createSessionsState()
  applyEvent(state, { type: "message.part.updated", properties: { part: { ...text } } })
  const snapshot = new MessageSnapshot(info.sessionID)
  const updated: Event = {
    type: "message.part.updated",
    properties: { part: { ...text, text: "old and new" }, delta: " and new" },
  }
  snapshot.observe(updated)
  applyEvent(state, updated)
  snapshot.apply(state, [{ info, parts: [{ ...text, text: "old and new" }] }])
  expect(state.part[info.id]).toEqual([{ ...text, text: "old and new" }])
})

test.each(["message", "part"] as const)("a late response cannot restore a removed %s", (removed) => {
  const state = createSessionsState()
  const snapshot = new MessageSnapshot(info.sessionID)
  const event: Event =
    removed === "message"
      ? { type: "message.removed", properties: { sessionID: info.sessionID, messageID: info.id } }
      : { type: "message.part.removed", properties: { sessionID: info.sessionID, messageID: info.id, partID: text.id } }
  snapshot.observe(event)
  applyEvent(state, event)
  snapshot.apply(state, history())
  expect(state.part[info.id] ?? []).toEqual([])
  expect(state.message[info.sessionID] ?? []).toEqual(removed === "message" ? [] : [info])
})

test("events for another session do not suppress this session's history", () => {
  const state = createSessionsState()
  const snapshot = new MessageSnapshot(info.sessionID)
  snapshot.observe({ type: "message.removed", properties: { sessionID: "other", messageID: info.id } })
  snapshot.apply(state, history())
  expect(state.part[info.id]).toEqual([text])
})

test("a late response preserves newer message metadata as well as its parts", () => {
  const state = createSessionsState()
  const snapshot = new MessageSnapshot(info.sessionID)
  const updated: Event = {
    type: "message.updated",
    properties: { sessionID: info.sessionID, info: { ...info, time: { created: 1, completed: 2 } } as MessageOutput },
  }
  snapshot.observe(updated)
  applyEvent(state, updated)
  snapshot.apply(state, history())
  expect(state.message[info.sessionID]?.[0]?.time).toEqual({ created: 1, completed: 2 })
  expect(state.part[info.id]).toEqual([text])
})

test.each(["deleted", "archived"] as const)("a late response cannot repopulate a %s session", (kind) => {
  const state = createSessionsState()
  const snapshot = new MessageSnapshot(info.sessionID)
  const session = {
    id: info.sessionID,
    time: { created: 1, updated: 1, ...(kind === "archived" ? { archived: 2 } : {}) },
  } as SessionOutput
  const event: Event = {
    type: kind === "deleted" ? "session.deleted" : "session.updated",
    properties: { sessionID: info.sessionID, info: session },
  }
  snapshot.observe(event)
  applyEvent(state, event)
  expect(snapshot.apply(state, history())).toBe(false)
  expect(state.message[info.sessionID]).toBeUndefined()
  expect(state.part[info.id]).toBeUndefined()
})
