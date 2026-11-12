import { expect, test } from "vitest"
import type { ModelMessage } from "@merakcode/sdk"
import { answer, turns, visibleParts, work } from "./turns"

const user = (text: string): ModelMessage => ({ role: "user", parts: [{ text }] })
const assistant = (text: string): ModelMessage => ({ role: "assistant", parts: [{ text }] })

test("each user message starts a turn and carries the identifier the engine reverts to", () => {
  const messages = [user("one"), assistant("first"), user("two"), assistant("second")]
  const result = turns(messages, [
    { id: "event-1", index: 0 },
    { id: "event-3", index: 2 },
  ])
  expect(result.map((turn) => turn.mark)).toEqual(["event-1", "event-3"])
  expect(result.map((turn) => turn.replies.length)).toEqual([1, 1])
})

test("a user message without a mark is shown but cannot be reverted to", () => {
  const result = turns([user("one"), assistant("first")], undefined)
  expect(result).toHaveLength(1)
  expect(result[0]!.mark).toBeUndefined()
})

test("tool calls stay out of the answer and the last text reply is the answer", () => {
  const messages: ModelMessage[] = [
    user("go"),
    { role: "assistant", parts: [{ toolCall: { id: "c", name: "bash", input: {} } }] },
    assistant("done"),
  ]
  const [turn] = turns(messages, [{ id: "event-1", index: 0 }])
  expect(answer(turn!).map((part) => part.text)).toEqual(["done"])
  expect(work(turn!).some((part) => part.toolCall)).toBe(true)
})

test("the parts the engine added for the model are not shown as what the person wrote", () => {
  const message: ModelMessage = {
    role: "user",
    parts: [
      { text: "Current date and time: 2026-11-12T14:00:00+08:00", synthetic: true },
      { text: "Recalled notes", synthetic: true },
      { text: "你好" },
    ],
  }
  expect(visibleParts(message).map((part) => part.text)).toEqual(["你好"])
})
