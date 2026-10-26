/**
 * sdk/store: the same event sequence yields the same session state. Clients such as the desktop app reduce engine
 * events with it.
 */
import { describe, expect, test } from "vitest"
import { activity, applyEvent, createSessionsState } from "@merakcode/sdk/store"
import type { Event } from "@merakcode/sdk/client"

const session = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: id, directory: "/p", time: { created: 1, updated: 1 }, ...extra }) as never
const message = (id: string, sessionID: string) => ({ id, sessionID, role: "user", time: { created: 1 } }) as never
const part = (id: string, messageID: string, text: string) =>
  ({ id, messageID, sessionID: "ses_a", type: "text", text }) as never

function run(events: Event[]) {
  const state = createSessionsState()
  for (const event of events) applyEvent(state, event)
  return state
}

describe("sessions", () => {
  test("created and updated sessions are inserted in id order; the same id again updates in place", () => {
    const state = run([
      { type: "session.created", properties: { info: session("ses_b") } },
      { type: "session.updated", properties: { info: session("ses_a") } },
      { type: "session.updated", properties: { info: session("ses_b", { title: "改名" }) } },
    ] as Event[])
    expect(state.session.map((item) => [item.id, item.title])).toEqual([
      ["ses_a", "ses_a"],
      ["ses_b", "改名"],
    ])
  })

  test("archiving or deleting removes the session with its messages, parts, requests, todos and status", () => {
    const state = run([
      { type: "session.updated", properties: { info: session("ses_a") } },
      { type: "session.updated", properties: { info: session("ses_b") } },
      { type: "message.updated", properties: { sessionID: "ses_a", info: message("msg_1", "ses_a") } },
      { type: "message.part.updated", properties: { part: part("prt_1", "msg_1", "hi") } },
      { type: "todo.updated", properties: { sessionID: "ses_a", todos: [] } },
      { type: "session.status", properties: { sessionID: "ses_a", status: { type: "busy" } } },
      {
        type: "session.updated",
        properties: { info: session("ses_a", { time: { created: 1, updated: 2, archived: 2 } }) },
      },
      { type: "session.deleted", properties: { info: session("ses_b") } },
    ] as Event[])
    expect(state.session).toEqual([])
    expect(state.message).toEqual({})
    expect(state.part).toEqual({})
    expect(state.todo).toEqual({})
    expect(state.session_status).toEqual({})
  })
})

describe("messages and parts", () => {
  test("streamed part updates update the same id in place and insert new ids in order", () => {
    const state = run([
      { type: "message.part.updated", properties: { part: part("prt_2", "msg_1", "b") } },
      { type: "message.part.updated", properties: { part: part("prt_1", "msg_1", "a") } },
      { type: "message.part.updated", properties: { part: part("prt_1", "msg_1", "a1"), delta: "1" } },
    ] as Event[])
    expect(state.part.msg_1!.map((item) => [item.id, "text" in item ? item.text : ""])).toEqual([
      ["prt_1", "a1"],
      ["prt_2", "b"],
    ])
  })

  test("updates merge in place so unchanged child objects keep the same reference", () => {
    const state = createSessionsState()
    const first = { ...part("prt_1", "msg_1", "a"), time: { start: 1 } } as never
    applyEvent(state, { type: "message.part.updated", properties: { part: first } } as Event)
    const time = (state.part.msg_1![0] as { time: object }).time
    applyEvent(state, {
      type: "message.part.updated",
      properties: { part: { ...part("prt_1", "msg_1", "ab"), time: { start: 1 } } },
    } as Event)
    expect((state.part.msg_1![0] as { time: object }).time).toBe(time)
    expect((state.part.msg_1![0] as { text: string }).text).toBe("ab")
  })

  test("removing a message removes its parts; a part list that becomes empty is dropped", () => {
    const state = run([
      { type: "message.updated", properties: { sessionID: "ses_a", info: message("msg_1", "ses_a") } },
      { type: "message.updated", properties: { sessionID: "ses_a", info: message("msg_2", "ses_a") } },
      { type: "message.part.updated", properties: { part: part("prt_1", "msg_1", "a") } },
      { type: "message.part.updated", properties: { part: part("prt_2", "msg_2", "b") } },
      { type: "message.removed", properties: { sessionID: "ses_a", messageID: "msg_1" } },
      { type: "message.part.removed", properties: { sessionID: "ses_a", messageID: "msg_2", partID: "prt_2" } },
    ] as Event[])
    expect(state.message.ses_a!.map((item) => item.id)).toEqual(["msg_2"])
    expect(state.part).toEqual({})
  })
})

describe("permissions, questions, todos, status and branch", () => {
  test("permissions and questions are added when asked and removed when replied to or rejected", () => {
    const ask = (id: string) => ({ id, sessionID: "ses_a", permission: "edit", patterns: [], metadata: {} })
    const question = (id: string) => ({ id, sessionID: "ses_a", questions: [] })
    const state = run([
      { type: "permission.asked", properties: ask("per_2") },
      { type: "permission.asked", properties: ask("per_1") },
      { type: "permission.replied", properties: { sessionID: "ses_a", requestID: "per_2", reply: "once" } },
      { type: "question.asked", properties: question("que_1") },
      { type: "question.asked", properties: question("que_2") },
      { type: "question.rejected", properties: { sessionID: "ses_a", requestID: "que_1" } },
      { type: "question.replied", properties: { sessionID: "ses_a", requestID: "que_2", answers: [] } },
    ] as Event[])
    expect(state.permission.ses_a!.map((item) => item.id)).toEqual(["per_1"])
    expect(state.question.ses_a).toEqual([])
  })

  test("todos, diffs and status are replaced whole; the branch updates only when its name changes", () => {
    const state = run([
      {
        type: "todo.updated",
        properties: { sessionID: "ses_a", todos: [{ id: "1", content: "x", status: "pending", priority: "high" }] },
      },
      {
        type: "session.diff",
        properties: { sessionID: "ses_a", diff: [{ file: "a.ts", before: "", after: "", additions: 1, deletions: 0 }] },
      },
      { type: "session.status", properties: { sessionID: "ses_a", status: { type: "busy" } } },
      { type: "session.status", properties: { sessionID: "ses_a", status: { type: "idle" } } },
      { type: "vcs.branch.updated", properties: { branch: "main" } },
    ] as Event[])
    expect(state.todo.ses_a).toHaveLength(1)
    expect(state.session_diff.ses_a!.map((item) => item.file)).toEqual(["a.ts"])
    expect(state.session_status.ses_a).toEqual({ type: "idle" })
    expect(state.vcs).toEqual({ branch: "main", head: null, checkout: null, staged: 0, unstaged: 0, untracked: 0 })
  })

  test("the return value says what happened, for the product's own bookkeeping (session count, trimming)", () => {
    const state = createSessionsState()
    expect(applyEvent(state, { type: "session.created", properties: { info: session("ses_a") } } as Event)).toBe(
      "insert",
    )
    expect(applyEvent(state, { type: "session.updated", properties: { info: session("ses_a") } } as Event)).toBe(
      "update",
    )
    expect(applyEvent(state, { type: "session.deleted", properties: { info: session("ses_a") } } as Event)).toBe(
      "remove",
    )
    expect(applyEvent(state, { type: "session.deleted", properties: { info: session("ses_a") } } as Event)).toBe("none")
    expect(applyEvent(state, { type: "lsp.updated", properties: {} } as Event)).toBe("ignored")
  })
})

describe("conversation status (sidebar)", () => {
  const status = (sessionID: string, type: string) =>
    ({ type: "session.status", properties: { sessionID, status: { type } } }) as Event
  const child = { type: "session.created", properties: { info: session("ses_c", { parentID: "ses_a" }) } } as Event

  test("approval > question > running > idle, with child session activity counted toward the root", () => {
    const base = [{ type: "session.created", properties: { info: session("ses_a") } } as Event, child]
    expect(activity(run([...base, status("ses_a", "idle")]), "ses_a")).toBe("idle")
    expect(activity(run([...base, status("ses_c", "busy")]), "ses_a")).toBe("running")
    expect(activity(run([...base, status("ses_a", "retry")]), "ses_a")).toBe("running")
    const question = { type: "question.asked", properties: { id: "que_1", sessionID: "ses_c", questions: [] } } as Event
    expect(activity(run([...base, status("ses_a", "busy"), question]), "ses_a")).toBe("question")
    const permission = {
      type: "permission.asked",
      properties: { id: "per_1", sessionID: "ses_c", root: "ses_a", permission: "edit", patterns: [] },
    } as Event
    expect(activity(run([...base, question, permission]), "ses_a")).toBe("approval")
    expect(activity(run([...base, question, permission]), "ses_b")).toBe("idle")
  })

  test("a background child (memory extraction after a reply) does not keep the conversation running", () => {
    const base = [
      { type: "session.created", properties: { info: session("ses_a") } } as Event,
      {
        type: "session.created",
        properties: { info: session("ses_m", { parentID: "ses_a", metadata: { background: true } }) },
      } as Event,
      child,
    ]
    expect(activity(run([...base, status("ses_a", "idle"), status("ses_m", "busy")]), "ses_a")).toBe("idle")
    expect(activity(run([...base, status("ses_m", "busy"), status("ses_c", "busy")]), "ses_a")).toBe("running")
  })
})
