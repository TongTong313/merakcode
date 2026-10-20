import { describe, expect, test } from "vitest"
import type { Message, Part } from "@merakcode/sdk/client"
import { blocks, changes, explored, turns } from "./turns"

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
