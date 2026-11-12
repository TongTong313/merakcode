import { expect, test } from "vitest"
import type { EngineEvent } from "@merakcode/sdk"
import { chatItems, sayText } from "./timeline"

let counter = 0
const at = (type: string, stream: string, payload: unknown, extra: Partial<EngineEvent> = {}) =>
  ({
    id: `E${String(++counter).padStart(3, "0")}`,
    type,
    stream,
    scope: { group: "g" },
    time: "2026-11-12T10:00:00Z",
    seq: counter,
    actor: { kind: "agent", id: "leader" },
    payload,
    ...extra,
  }) as unknown as EngineEvent

const group = "group:g"
const leaderSession = "session:thread"
const thread = { group: "g", session: "thread" }
const human = { kind: "human", id: "me" } as const
const claimMember = (claim: string) => (claim === "c1" ? "worker" : undefined)
const context = { claimMember }

test("a human message, the Leader's work, a created task and its reply come out in the order they happened", () => {
  const said = at("human.said", group, { text: "Plan the release", to: ["leader"] }, { actor: human })
  const work = at(
    "message.completed",
    leaderSession,
    {
      role: "assistant",
      parts: [
        { toolCall: { id: "c1", name: "create_task", input: { title: "Ship" } } },
        { toolCall: { id: "c2", name: "say", input: { text: "On it" } } },
      ],
    },
    { scope: thread },
  )
  const created = at("task.created", group, { id: "t1", title: "Ship" }, { scope: { group: "g", task: "t1" } })
  const reply = at("message.completed", group, { role: "assistant", parts: [{ text: "On it" }] }, { scope: thread })
  const items = chatItems([reply, created, work, said], context)
  expect(items.map((item) => item.kind)).toEqual(["human", "work", "task", "reply"])
  expect(items[0]).toMatchObject({ id: said.id, text: "Plan the release", to: ["leader"], status: "" })
  expect(items[2]).toMatchObject({ task: "t1" })
  expect(items[3]).toMatchObject({ authorID: "leader", text: "On it" })
})

test("the work of the Leader leaves out the say call, which shows as the reply, and is dropped when nothing else is in it", () => {
  const onlySay = at(
    "message.completed",
    leaderSession,
    { role: "assistant", parts: [{ toolCall: { id: "c", name: "say", input: { text: "Hi" } } }] },
    { scope: thread },
  )
  const mixed = at(
    "message.completed",
    leaderSession,
    {
      role: "assistant",
      parts: [
        { text: "Thinking aloud" },
        { toolCall: { id: "d", name: "say", input: { text: "Hi" } } },
        { toolCall: { id: "e", name: "todo_write", input: {} } },
      ],
    },
    { scope: thread },
  )
  const items = chatItems([onlySay, mixed], context)
  expect(items).toHaveLength(1)
  const parts = (items[0] as { parts: { toolCall?: { name: string } }[] }).parts
  expect(parts.map((part) => part.toolCall?.name)).toEqual([undefined, "todo_write"])
})

test("a message is delivered once the group has it, and processing once the Leader's model has read it", () => {
  const said = at("human.said", group, { text: "Second thought" }, { actor: human })
  expect(chatItems([said], context)[0]).toMatchObject({ status: "" })
  const receipt = at("notice.sent", group, { kind: "receipt", text: "", to: ["me"] }, { cause: said.id })
  expect(chatItems([said, receipt], context)[0]).toMatchObject({ status: "delivered" })
  const consumed = at("input.consumed", leaderSession, { session: "thread" }, { cause: said.id, scope: thread })
  expect(chatItems([said, receipt, consumed], context)[0]).toMatchObject({ status: "processing" })
})

test("a message to a working member says to whom it was delivered", () => {
  const said = at("human.said", group, { text: "@Worker also check links", to: ["worker"] }, { actor: human })
  const delivered = at("input.delivered", group, { claim: "c1" }, { cause: said.id, actor: human })
  expect(chatItems([said, delivered], context)[0]).toMatchObject({ status: "delivered", deliveredTo: ["worker"] })
})

test("only the latest progress line of a claim is kept", () => {
  const first = at(
    "task.progress",
    "device:d",
    { claim: "c1", summary: "Read the guide" },
    { scope: { group: "g", task: "t1" } },
  )
  const second = at(
    "task.progress",
    "device:d",
    { claim: "c1", summary: "Fixed three links" },
    { scope: { group: "g", task: "t1" } },
  )
  const items = chatItems([first, second], context)
  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({ kind: "progress", text: "Fixed three links", authorID: "worker", task: "t1" })
})

test("the text of a say call is read while its input is still streaming in", () => {
  expect(sayText({ text: "Done" })).toBe("Done")
  expect(sayText(String.raw`{"text":"I will coor`)).toBe("I will coor")
  expect(sayText(String.raw`{"text":"Line one\nLine \"two\"`)).toBe('Line one\nLine "two"')
  expect(sayText(String.raw`{"text":"Say \"hi\"","x":1}`)).toBe('Say "hi"')
  expect(sayText('{"text":"Half' + "\\")).toBe("Half")
  expect(sayText('{"te')).toBe("")
  expect(sayText(undefined)).toBe("")
})
