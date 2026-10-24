import { describe, expect, test } from "vitest"
import type { Message, Part } from "@merakcode/sdk/client"
import { blocks, changes, eventsByTurn, explored, segments, turns, working } from "./turns"

const user = (id: string) => ({ id, role: "user", sessionID: "s", time: { created: 1 } }) as Message
const reply = (id: string, parentID: string) => ({ id, role: "assistant", parentID, sessionID: "s" }) as Message
const tool = (id: string, name: string, input: Record<string, unknown> = {}) =>
  ({ id, type: "tool", tool: name, state: { status: "completed", input } }) as Part
const text = (id: string, value: string, synthetic = false) => ({ id, type: "text", text: value, synthetic }) as Part

describe("turns", () => {
  test("groups replies by parentID, falls back to the previous turn, and keeps leading replies as orphans", () => {
    const result = turns([
      reply("a0", "x"),
      user("u1"),
      reply("a1", "u1"),
      user("u2"),
      reply("a2", "u1"),
      reply("a3", "zz"),
    ])
    expect(result.orphans.map((item) => item.id)).toEqual(["a0"])
    expect(result.turns.map((turn) => [turn.user.id, turn.replies.map((item) => item.id)])).toEqual([
      ["u1", ["a1", "a2"]],
      ["u2", ["a3"]],
    ])
  })
})

describe("blocks", () => {
  test("merges adjacent reads and searches, splits them at other parts, hides internal parts and empty text", () => {
    const result = blocks([
      { id: "s", type: "step-start" } as Part,
      tool("1", "read", { filePath: "a" }),
      tool("2", "grep"),
      tool("3", "read", { filePath: "a" }),
      text("4", "看完了"),
      text("5", "  "),
      text("6", "系统加的", true),
      tool("7", "bash"),
      tool("8", "glob"),
    ])
    expect(
      result.map((block) => (block.kind === "explore" ? block.parts.map((part) => part.id) : block.part.id)),
    ).toEqual([["1", "2", "3"], "4", "7", ["8"]])
    const first = result[0]!
    expect(first.kind === "explore" && explored(first.parts)).toEqual({ reads: 1, searches: 1 })
  })
})

describe("changes", () => {
  const edit = (id: string, file: string, before: string, after: string, status?: string) =>
    ({
      id,
      type: "tool",
      tool: "edit",
      state: {
        status: "completed",
        input: { filePath: file },
        metadata: { filediff: { file, before, after, status } },
      },
    }) as unknown as Part

  test("counts a file edited several times from before the first edit to after the last, sorted by path", () => {
    const result = changes([
      edit("1", "/p/b.ts", "a\nb\n", "a\nB\n"),
      edit("2", "/p/a.ts", "", "x\n", "added"),
      edit("3", "/p/b.ts", "a\nB\n", "a\nB\nc\n"),
      tool("4", "bash"),
    ])
    expect(result).toEqual([
      { file: "/p/a.ts", additions: 1, deletions: 0 },
      { file: "/p/b.ts", additions: 2, deletions: 1 },
    ])
  })

  test("skips files edited back to their original content", () => {
    expect(changes([edit("1", "/p/a.ts", "a\n", "b\n"), edit("2", "/p/a.ts", "b\n", "a\n")])).toEqual([])
  })
})

describe("group chat", () => {
  test("two members delegated in one step read as two messages between the leader's own", () => {
    const result = segments([
      { id: "s", type: "step-start" } as Part,
      text("1", "好，分头做"),
      tool("2", "delegate", { seat: "小红" }),
      tool("3", "delegate", { seat: "abc" }),
      { id: "f", type: "step-finish" } as Part,
      tool("4", "read", { filePath: "a" }),
      text("5", "都做完了"),
    ])
    expect(
      result.map((segment) =>
        segment.kind === "seat" ? segment.part.state.input.seat : segment.blocks.map((block) => block.kind),
      ),
    ).toEqual([["part"], "小红", "abc", ["explore", "part"]])
  })

  test("a step with only delegate calls leaves no empty leader message", () => {
    expect(segments([{ id: "s", type: "step-start" } as Part, tool("1", "delegate", { seat: "小红" })])).toHaveLength(1)
  })

  test("membership lines go before the first turn that started after them", () => {
    const join = { at: 5, kind: "join" }
    const rename = { at: 15, kind: "rename" }
    const leave = { at: 25, kind: "leave" }
    expect(eventsByTurn([join, rename, leave], [10, 20])).toEqual([[join], [rename], [leave]])
    expect(eventsByTurn([join], [])).toEqual([[join]])
  })
})

describe("working", () => {
  const call = (id: string, state: Record<string, unknown>) =>
    ({ id, type: "tool", tool: "delegate", state: { input: {}, ...state } }) as Part
  test("only members whose delegation has started count as working; queued and finished ones do not", () => {
    const result = working(
      [
        call("1", { status: "running", metadata: { seatID: "s2" } }),
        call("2", { status: "running", metadata: { seatID: "s3", phase: "queued" } }),
        call("3", { status: "completed", metadata: { seatID: "s4" } }),
        call("4", { status: "pending" }),
        tool("5", "bash"),
      ],
      true,
    )
    expect([...result]).toEqual(["s2"])
  })

  test("nobody is working once the turn has stopped, even if a stopped call still reads as running", () => {
    const running = call("1", { status: "running", metadata: { seatID: "s2" } })
    expect([...working([running], false)]).toEqual([])
    expect([...working([running], true)]).toEqual(["s2"])
  })
})
