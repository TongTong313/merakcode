import { describe, expect, test } from "vitest"
import path from "path"
import { pathToFileURL } from "url"
import { RuleWorkingSet } from "./working-set"
import { SessionToolResult } from "../../session/tool-result"
import type { Message } from "../../session/message"

const ROOT = path.resolve("/repo")

function userMsg(parts: Message.Part[]): Message.FullMsg {
  return {
    info: {
      id: "u1",
      role: "user",
      sessionID: "s",
      time: { created: 0 },
      agent: "build",
      model: { providerID: "test", modelID: "test" },
    } as Message.UserInfo,
    parts,
  }
}

function filePart(filepath: string, mime = "text/plain"): Message.FilePart {
  return {
    id: "p1",
    sessionID: "s",
    messageID: "u1",
    type: "file",
    mime,
    url: pathToFileURL(filepath).href,
    filename: path.basename(filepath),
  }
}

function toolPart(tool: string, filePath: string, output: string, extra?: { compacted?: number }): Message.ToolPart {
  return {
    id: "t1",
    sessionID: "s",
    messageID: "a1",
    type: "tool",
    tool,
    callID: "c1",
    state: {
      status: "completed",
      input: { filePath },
      output,
      title: "",
      metadata: {},
      time: { start: 0, end: 1, compacted: extra?.compacted },
    },
  } as Message.ToolPart
}

describe("RuleWorkingSet.fromMentions", () => {
  test("takes file parts from the current user message", () => {
    const ts = path.join(ROOT, "src", "a.ts")
    const msgs = [userMsg([filePart(ts)])]
    expect(RuleWorkingSet.fromMentions(msgs)).toEqual([path.resolve(ts)])
  })

  test("skips directories", () => {
    const dir = path.join(ROOT, "src")
    const msgs = [userMsg([filePart(dir, "application/x-directory")])]
    expect(RuleWorkingSet.fromMentions(msgs)).toEqual([])
  })
})

describe("RuleWorkingSet.fromPromptContent", () => {
  test("includes a completed uncompacted read", () => {
    const ts = path.join(ROOT, "src", "a.ts")
    const msgs: Message.FullMsg[] = [
      {
        info: { id: "a1", role: "assistant" } as Message.AssistantInfo,
        parts: [toolPart("read", ts, "<path>a.ts</path>\nconst x = 1")],
      },
    ]
    expect(RuleWorkingSet.fromPromptContent(msgs)).toEqual([path.resolve(ts)])
  })

  test("skips compacted and stale reads", () => {
    const ts = path.join(ROOT, "src", "a.ts")
    const css = path.join(ROOT, "src", "a.css")
    const msgs: Message.FullMsg[] = [
      {
        info: { id: "a1", role: "assistant" } as Message.AssistantInfo,
        parts: [
          toolPart("read", ts, SessionToolResult.PLACEHOLDER, { compacted: 1 }),
          toolPart(
            "read",
            css,
            "[Read content stale: a.css was modified after this read - re-read for current content.]",
          ),
        ],
      },
    ]
    expect(RuleWorkingSet.fromPromptContent(msgs)).toEqual([])
  })

  test("ignores grep", () => {
    const ts = path.join(ROOT, "src", "a.ts")
    const msgs: Message.FullMsg[] = [
      {
        info: { id: "a1", role: "assistant" } as Message.AssistantInfo,
        parts: [toolPart("grep", ts, "src/a.ts:1: hello")],
      },
    ]
    expect(RuleWorkingSet.fromPromptContent(msgs)).toEqual([])
  })
})

describe("RuleWorkingSet.fromRecent", () => {
  const ts = path.resolve(path.join(ROOT, "src", "a.ts"))
  const css = path.resolve(path.join(ROOT, "src", "a.css"))

  test("keeps files from the last N user turns", () => {
    expect(
      RuleWorkingSet.fromRecent(
        {
          userTurns: ["u1", "u2", "u3"],
          recentFiles: [
            { path: ts, userMessageID: "u1" },
            { path: css, userMessageID: "u3" },
          ],
        },
        2,
      ),
    ).toEqual([css])
  })
})
