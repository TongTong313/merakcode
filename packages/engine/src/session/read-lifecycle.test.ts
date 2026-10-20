import { describe, expect, test } from "vitest"
import { Message } from "./message"
import { applyReadLifecycle, resolveReadLifecycleConfig } from "./read-lifecycle"

const sessionID = "test-session"
const cwd = "/project"

// Disable the protection window (recentTurns=0) to test classification on its own
const openConfig = { ...resolveReadLifecycleConfig(undefined), recentTurns: 0 }

function userMsg(id: string): Message.FullMsg {
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: 0 },
      agent: "build",
      model: { providerID: "t", modelID: "t" },
    },
    parts: [{ id: `t-${id}`, messageID: id, sessionID, type: "text" as const, text: "go" }],
  } as Message.FullMsg
}

function assistantMsg(id: string, parts: Message.Part[]): Message.FullMsg {
  return {
    info: { id, sessionID, role: "assistant", agent: "build", mode: "build", time: { created: 0 } },
    parts,
  } as unknown as Message.FullMsg
}

function readPart(
  msgID: string,
  id: string,
  callID: string,
  filePath: string,
  output: string,
  offset?: number,
  limit?: number,
): Message.ToolPart {
  return {
    id,
    messageID: msgID,
    sessionID,
    type: "tool",
    callID,
    tool: "read",
    state: {
      status: "completed",
      input: { filePath, ...(offset != null && { offset }), ...(limit != null && { limit }) },
      output,
      title: "Read",
      metadata: {},
      time: { start: 0, end: 0 },
    },
  }
}

function editPart(msgID: string, id: string, callID: string, filePath: string): Message.ToolPart {
  return {
    id,
    messageID: msgID,
    sessionID,
    type: "tool",
    callID,
    tool: "edit",
    state: {
      status: "completed",
      input: { filePath, oldString: "a", newString: "b" },
      output: "done",
      title: "Edit",
      metadata: {},
      time: { start: 0, end: 0 },
    },
  }
}

function writePart(msgID: string, id: string, callID: string, filePath: string): Message.ToolPart {
  return {
    id,
    messageID: msgID,
    sessionID,
    type: "tool",
    callID,
    tool: "write",
    state: {
      status: "completed",
      input: { filePath, content: "new" },
      output: "done",
      title: "Write",
      metadata: {},
      time: { start: 0, end: 0 },
    },
  }
}

const BIG = "x".repeat(600)

function outputAt(messages: Message.FullMsg[], msgIndex: number, partIndex: number): string {
  const part = messages[msgIndex].parts[partIndex] as Message.ToolPart
  return part.state.status === "completed" ? part.state.output : ""
}

describe("applyReadLifecycle - classification", () => {
  test("replaces a read with a stale marker when the same file is edited later", () => {
    const messages = [
      userMsg("u1"),
      assistantMsg("a1", [readPart("a1", "r1", "c1", "/project/src/foo.ts", BIG)]),
      assistantMsg("a2", [editPart("a2", "e1", "c2", "/project/src/foo.ts")]),
    ]
    const result = applyReadLifecycle(messages, openConfig, cwd)
    expect(outputAt(result, 1, 0)).toContain("stale")
    expect(outputAt(result, 1, 0)).toContain("foo.ts")
  })

  test("replaces a read with a superseded marker when the whole file is read again", () => {
    const messages = [
      userMsg("u1"),
      assistantMsg("a1", [readPart("a1", "r1", "c1", "/project/src/foo.ts", BIG)]),
      assistantMsg("a2", [readPart("a2", "r2", "c2", "/project/src/foo.ts", BIG)]),
    ]
    const result = applyReadLifecycle(messages, openConfig, cwd)
    expect(outputAt(result, 1, 0)).toContain("superseded")
    expect(outputAt(result, 2, 0)).toBe(BIG)
  })

  test("keeps a read with no later operations", () => {
    const messages = [userMsg("u1"), assistantMsg("a1", [readPart("a1", "r1", "c1", "/project/src/foo.ts", BIG)])]
    const result = applyReadLifecycle(messages, openConfig, cwd)
    expect(outputAt(result, 1, 0)).toBe(BIG)
  })

  test("keeps a read of file A when only file B is edited", () => {
    const messages = [
      userMsg("u1"),
      assistantMsg("a1", [readPart("a1", "r1", "c1", "/project/src/a.ts", BIG)]),
      assistantMsg("a2", [editPart("a2", "e1", "c2", "/project/src/b.ts")]),
    ]
    const result = applyReadLifecycle(messages, openConfig, cwd)
    expect(outputAt(result, 1, 0)).toBe(BIG)
  })

  test("prefers stale over superseded for read, edit, read", () => {
    const messages = [
      userMsg("u1"),
      assistantMsg("a1", [readPart("a1", "r1", "c1", "/project/src/foo.ts", BIG)]),
      assistantMsg("a2", [editPart("a2", "e1", "c2", "/project/src/foo.ts")]),
      assistantMsg("a3", [readPart("a3", "r2", "c3", "/project/src/foo.ts", BIG)]),
    ]
    const result = applyReadLifecycle(messages, openConfig, cwd)
    expect(outputAt(result, 1, 0)).toContain("stale")
  })
})

describe("applyReadLifecycle - line ranges", () => {
  test("partial read(100,50) is not superseded by a non-covering partial read(200,50)", () => {
    const messages = [
      userMsg("u1"),
      assistantMsg("a1", [readPart("a1", "r1", "c1", "/project/src/foo.ts", BIG, 100, 50)]),
      assistantMsg("a2", [readPart("a2", "r2", "c2", "/project/src/foo.ts", BIG, 200, 50)]),
    ]
    const result = applyReadLifecycle(messages, openConfig, cwd)
    expect(outputAt(result, 1, 0)).toBe(BIG)
  })

  test("partial read(100,50) is superseded by a later full read", () => {
    const messages = [
      userMsg("u1"),
      assistantMsg("a1", [readPart("a1", "r1", "c1", "/project/src/foo.ts", BIG, 100, 50)]),
      assistantMsg("a2", [readPart("a2", "r2", "c2", "/project/src/foo.ts", BIG)]),
    ]
    const result = applyReadLifecycle(messages, openConfig, cwd)
    expect(outputAt(result, 1, 0)).toContain("superseded")
  })

  test("partial read(100,100) is superseded by a covering partial read(50,200)", () => {
    const messages = [
      userMsg("u1"),
      assistantMsg("a1", [readPart("a1", "r1", "c1", "/project/src/foo.ts", BIG, 100, 100)]),
      assistantMsg("a2", [readPart("a2", "r2", "c2", "/project/src/foo.ts", BIG, 50, 200)]),
    ]
    const result = applyReadLifecycle(messages, openConfig, cwd)
    expect(outputAt(result, 1, 0)).toContain("superseded")
  })
})

describe("applyReadLifecycle - edit sources", () => {
  test("write marks an earlier read stale", () => {
    const messages = [
      userMsg("u1"),
      assistantMsg("a1", [readPart("a1", "r1", "c1", "/project/src/foo.ts", BIG)]),
      assistantMsg("a2", [writePart("a2", "e1", "c2", "/project/src/foo.ts")]),
    ]
    const result = applyReadLifecycle(messages, openConfig, cwd)
    expect(outputAt(result, 1, 0)).toContain("stale")
  })

  test("multi_edit marks an earlier read stale", () => {
    const messages = [
      userMsg("u1"),
      assistantMsg("a1", [readPart("a1", "r1", "c1", "/project/src/foo.ts", BIG)]),
      assistantMsg("a2", [
        {
          id: "e1",
          messageID: "a2",
          sessionID,
          type: "tool",
          callID: "c2",
          tool: "multi_edit",
          state: {
            status: "completed",
            input: { filePath: "src/foo.ts", edits: [{ oldString: "a", newString: "b" }] },
            output: "done",
            title: "MultiEdit",
            metadata: {},
            time: { start: 0, end: 0 },
          },
        } as Message.ToolPart,
      ]),
    ]
    const result = applyReadLifecycle(messages, openConfig, cwd)
    // The relative path is normalized to match the absolute read path
    expect(outputAt(result, 1, 0)).toContain("stale")
  })

  test("historical apply_patch calls from the removed tool do not mark reads stale", () => {
    const messages = [
      userMsg("u1"),
      assistantMsg("a1", [readPart("a1", "r1", "c1", "/project/src/foo.ts", BIG)]),
      assistantMsg("a2", [
        {
          id: "e1",
          messageID: "a2",
          sessionID,
          type: "tool",
          callID: "c2",
          tool: "apply_patch",
          state: {
            status: "completed",
            input: { patchText: "*** Begin Patch\n*** Update File: src/foo.ts\n@@\n-a\n+b\n*** End Patch" },
            output: "done",
            title: "ApplyPatch",
            metadata: {},
            time: { start: 0, end: 0 },
          },
        } as Message.ToolPart,
      ]),
    ]
    const result = applyReadLifecycle(messages, openConfig, cwd)
    expect(outputAt(result, 1, 0)).toBe(BIG)
  })
})

describe("applyReadLifecycle - edge cases", () => {
  test("skips reads that are already compacted", () => {
    const messages = [
      userMsg("u1"),
      assistantMsg("a1", [
        {
          ...readPart("a1", "r1", "c1", "/project/src/foo.ts", BIG),
          state: {
            ...(readPart("a1", "r1", "c1", "/project/src/foo.ts", BIG).state as Message.ToolStateCompleted),
            time: { start: 0, end: 0, compacted: 1 },
          },
        },
      ]),
      assistantMsg("a2", [editPart("a2", "e1", "c2", "/project/src/foo.ts")]),
    ]
    const result = applyReadLifecycle(messages, openConfig, cwd)
    expect(outputAt(result, 1, 0)).toBe(BIG)
  })

  test("keeps output smaller than minSizeBytes", () => {
    const small = "x".repeat(100)
    const messages = [
      userMsg("u1"),
      assistantMsg("a1", [readPart("a1", "r1", "c1", "/project/src/foo.ts", small)]),
      assistantMsg("a2", [editPart("a2", "e1", "c2", "/project/src/foo.ts")]),
    ]
    const result = applyReadLifecycle(messages, openConfig, cwd)
    expect(outputAt(result, 1, 0)).toBe(small)
  })

  test("does nothing when enabled is false", () => {
    const messages = [
      userMsg("u1"),
      assistantMsg("a1", [readPart("a1", "r1", "c1", "/project/src/foo.ts", BIG)]),
      assistantMsg("a2", [editPart("a2", "e1", "c2", "/project/src/foo.ts")]),
    ]
    const result = applyReadLifecycle(messages, { ...openConfig, enabled: false }, cwd)
    expect(outputAt(result, 1, 0)).toBe(BIG)
  })

  test("does not mutate the input messages", () => {
    const messages = [
      userMsg("u1"),
      assistantMsg("a1", [readPart("a1", "r1", "c1", "/project/src/foo.ts", BIG)]),
      assistantMsg("a2", [editPart("a2", "e1", "c2", "/project/src/foo.ts")]),
    ]
    applyReadLifecycle(messages, openConfig, cwd)
    expect(outputAt(messages, 1, 0)).toBe(BIG)
  })

  test("matches an absolute read path with a relative edit path", () => {
    const messages = [
      userMsg("u1"),
      assistantMsg("a1", [readPart("a1", "r1", "c1", "/project/src/foo.ts", BIG)]),
      assistantMsg("a2", [editPart("a2", "e1", "c2", "src/foo.ts")]),
    ]
    const result = applyReadLifecycle(messages, openConfig, cwd)
    expect(outputAt(result, 1, 0)).toContain("stale")
  })
})

describe("applyReadLifecycle - protection window", () => {
  test("recentTurns=2 still replaces a stale read before the last 2 user turns", () => {
    // Order: u1 -> read -> u2 -> edit -> u3
    // The last 2 user turns are u2 and u3, so boundary = 2 (index of u2).
    // read.msgIndex = 1 < 2 is outside the window, and the later edit makes it stale.
    const messages = [
      userMsg("u1"),
      assistantMsg("a1", [readPart("a1", "r1", "c1", "/project/src/foo.ts", BIG)]),
      userMsg("u2"),
      assistantMsg("a2", [editPart("a2", "e1", "c2", "/project/src/foo.ts")]),
      userMsg("u3"),
    ]
    const result = applyReadLifecycle(messages, { ...resolveReadLifecycleConfig(undefined) }, cwd)
    expect(outputAt(result, 1, 0)).toContain("stale")
  })

  test("recentTurns=2 keeps a read within the last 2 user turns", () => {
    // Order: u1 -> edit -> u2 -> read -> u3
    // The last 2 user turns are u2 (idx 2) and u3 (idx 4), so boundary = 2.
    // read.msgIndex = 3 >= 2 is inside the window and is kept.
    const messages = [
      userMsg("u1"),
      assistantMsg("a1", [editPart("a1", "e1", "c1", "/project/src/foo.ts")]),
      userMsg("u2"),
      assistantMsg("a2", [readPart("a2", "r1", "c2", "/project/src/foo.ts", BIG)]),
      userMsg("u3"),
    ]
    const result = applyReadLifecycle(messages, { ...resolveReadLifecycleConfig(undefined) }, cwd)
    // This read follows the edit so it is not stale, but it would be kept even if it were
    expect(outputAt(result, 3, 0)).toBe(BIG)
  })
})

describe("resolveReadLifecycleConfig", () => {
  test("enables everything by default", () => {
    const c = resolveReadLifecycleConfig(undefined)
    expect(c.enabled).toBe(true)
    expect(c.stale).toBe(true)
    expect(c.superseded).toBe(true)
  })

  test("false disables the feature entirely", () => {
    expect(resolveReadLifecycleConfig(false).enabled).toBe(false)
  })

  test("an object config can disable superseded alone", () => {
    const c = resolveReadLifecycleConfig({ superseded: false })
    expect(c.stale).toBe(true)
    expect(c.superseded).toBe(false)
  })
})
