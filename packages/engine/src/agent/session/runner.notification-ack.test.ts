import { describe, expect, test } from "vitest"
import { Message } from "./message"
import { Loop } from "../loop/index"

/**
 * Unit tests for the runner's pure decision functions, covering two paths related to ESC interrupts. They are tested
 * in isolation to avoid real Storage, LLM and delivery side effects:
 *
 * 1. shouldAckDeliveredTurn: whether a notification turn is acked.
 *    When a workflow completes or is cancelled, SessionNotification delivers a synthetic user message and the LLM
 *    streams a reply. If the user presses ESC, the processor sets assistant.error to MessageAbortedError. Without an
 *    ack, cancel() sets the session idle and the deliverer immediately redelivers the same notification with
 *    {delay:0}, looping ESC -> idle -> redeliver -> stream -> ESC. The function acks successful and user-interrupted
 *    turns, but not real failures.
 *
 * 2. shouldExitLoop: whether the agent loop exits at the top.
 *    On abort the processor writes only error (MessageAbortedError), not finish. Judging by finish alone would make the
 *    next loop treat the interrupted turn as unfinished and call the LLM again, so the model keeps working after ESC.
 *    An interrupted assistant message also ends the turn.
 */

// Both functions read only error, finish, id and parentID, so a minimal object with a type assertion is enough.
const assistant = (fields: { error?: unknown; finish?: string; id?: string; parentID?: string } = {}) =>
  ({ ...fields }) as unknown as Message.AssistantInfo

const abortedError = () => new Message.AbortedError({ message: "Operation aborted by user" }).toObject()

describe("Loop.__test.shouldAckDeliveredTurn", () => {
  test("does not ack without an assistant reply", () => {
    expect(Loop.__test.shouldAckDeliveredTurn(undefined)).toBe(false)
  })

  test("acks a successful turn", () => {
    expect(Loop.__test.shouldAckDeliveredTurn(assistant({}))).toBe(true)
  })

  test("acks a user-interrupted turn so it is not redelivered in a loop", () => {
    expect(Loop.__test.shouldAckDeliveredTurn(assistant({ error: abortedError() }))).toBe(true)
  })

  test("does not ack a real failure so backoff retry still applies", () => {
    // OutputLengthError is a real, non-abort error
    const error = new Message.OutputLengthError({}).toObject()
    expect(Message.AbortedError.isInstance(error)).toBe(false)
    expect(Loop.__test.shouldAckDeliveredTurn(assistant({ error }))).toBe(false)
  })

  test("does not ack APIError or other real failures", () => {
    const error = { name: "APIError", data: { message: "boom" } }
    expect(Message.AbortedError.isInstance(error)).toBe(false)
    expect(Loop.__test.shouldAckDeliveredTurn(assistant({ error }))).toBe(false)
  })
})

describe("Loop.__test.shouldExitLoop", () => {
  test("does not exit without an assistant reply", () => {
    expect(Loop.__test.shouldExitLoop(undefined, "user_1")).toBe(false)
  })

  test("exits after an interrupted assistant reply to the latest user message", () => {
    const a = assistant({ id: "msg_2", parentID: "msg_1", error: abortedError() })
    expect(Loop.__test.shouldExitLoop(a, "msg_1")).toBe(true)
  })

  test("does not exit after an interrupted reply when the user has sent a new message", () => {
    const a = assistant({ id: "msg_2", parentID: "msg_1", error: abortedError() })
    expect(Loop.__test.shouldExitLoop(a, "msg_3")).toBe(false)
  })

  test("exits after finish=stop for the latest user message", () => {
    const a = assistant({ id: "msg_2", parentID: "msg_1", finish: "stop" })
    expect(Loop.__test.shouldExitLoop(a, "msg_1")).toBe(true)
  })

  test("does not exit while tool calls are pending (finish=tool-calls)", () => {
    const a = assistant({ id: "msg_2", parentID: "msg_1", finish: "tool-calls" })
    expect(Loop.__test.shouldExitLoop(a, "msg_1")).toBe(false)
  })

  test("does not exit on finish=unknown without an error", () => {
    const a = assistant({ id: "msg_2", parentID: "msg_1", finish: "unknown" })
    expect(Loop.__test.shouldExitLoop(a, "msg_1")).toBe(false)
  })

  test("does not exit on a real failure (APIError)", () => {
    const a = assistant({ id: "msg_2", parentID: "msg_1", error: { name: "APIError", data: {} } })
    expect(Loop.__test.shouldExitLoop(a, "msg_1")).toBe(false)
  })

  test("exits after an interrupt even without finish", () => {
    // A real abort writes only error, not finish
    const a = assistant({ id: "msg_2", parentID: "msg_1", error: abortedError() })
    expect(a.finish).toBeUndefined()
    expect(Loop.__test.shouldExitLoop(a, "msg_1")).toBe(true)
  })

  // After the 48-bit message ID wraps around, a new user id can sort before the previous assistant id. Comparing ids
  // to detect a new message would exit immediately and the model would never run.
  test("does not exit when a new user message with a lower id is not the reply's parent", () => {
    const a = assistant({
      id: "msg_ff0000000000aaaaaaaaaaaa",
      parentID: "msg_old_user",
      finish: "stop",
    })
    expect(Loop.__test.shouldExitLoop(a, "msg_001000000000bbbbbbbbbbbb")).toBe(false)
  })
})

describe("Loop.__test.isTurnSettled", () => {
  test("returns false without a reply", () => {
    expect(Loop.__test.isTurnSettled(undefined)).toBe(false)
  })

  test("returns true for finish=stop", () => {
    expect(Loop.__test.isTurnSettled(assistant({ finish: "stop" }))).toBe(true)
  })

  test("returns true for an ESC interrupt without finish so notifications can be delivered", () => {
    const a = assistant({ error: abortedError() })
    expect(a.finish).toBeUndefined()
    expect(Loop.__test.isTurnSettled(a)).toBe(true)
  })

  test("returns false for a real failure without finish so delivery waits for backoff retry", () => {
    const a = assistant({ error: { name: "APIError", data: {} } })
    expect(Loop.__test.isTurnSettled(a)).toBe(false)
  })

  test("returns false while tool calls are pending (finish=tool-calls)", () => {
    expect(Loop.__test.isTurnSettled(assistant({ finish: "tool-calls" }))).toBe(false)
  })

  test("returns false for finish=unknown without an error", () => {
    expect(Loop.__test.isTurnSettled(assistant({ finish: "unknown" }))).toBe(false)
  })
})
