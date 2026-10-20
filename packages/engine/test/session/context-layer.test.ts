import { describe, expect, test } from "vitest"
import type { Provider } from "@merakcode/engine/provider/provider"
import { SessionContextLayer } from "@merakcode/engine/session/context-layer"
import { Message } from "@merakcode/engine/session/message"

const sessionID = "session"

function model(): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test Model",
    limit: {
      context: 128_000,
      input: 0,
      output: 8_192,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    api: { id: "test-model", npm: "@ai-sdk/anthropic", url: "https://example.com" },
    options: {},
    headers: {},
    status: "active",
  } as Provider.Model
}

function user(id: string, text: string): Message.FullMsg {
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: 0 },
      agent: "build",
      model: { providerID: "test", modelID: "test-model" },
    } as Message.UserInfo,
    parts: [
      {
        id: `part_${id}`,
        messageID: id,
        sessionID,
        type: "text",
        text,
      },
    ],
  }
}

function compactionControl(id: string): Message.FullMsg {
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: 0 },
      agent: "build",
      model: { providerID: "test", modelID: "test-model" },
    } as Message.UserInfo,
    parts: [
      {
        id: `part_${id}`,
        messageID: id,
        sessionID,
        type: "compaction",
        auto: true,
      },
    ],
  }
}

function summary(id: string, parentID: string, text: string): Message.FullMsg {
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      parentID,
      mode: "compaction",
      agent: "compaction",
      summary: true,
      finish: "stop",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model",
      providerID: "test",
      time: { created: 0 },
    } as Message.AssistantInfo,
    parts: [
      {
        id: `part_${id}`,
        messageID: id,
        sessionID,
        type: "text",
        text,
      },
    ],
  }
}

describe("SessionContextLayer", () => {
  test("projects previous summary as a base layer and keeps only newer delta messages", async () => {
    const messages = [
      user("msg_001", "old request"),
      compactionControl("msg_002"),
      summary("msg_003", "msg_002", "old summary"),
      user("msg_004", "new request"),
    ]

    const projected = SessionContextLayer.project({ messages })

    expect(projected.baseSummary).toBe("old summary")
    expect(projected.deltaMessages.map((msg) => msg.info.id)).toEqual(["msg_004"])

    const result = await SessionContextLayer.toModelMessages({ messages, model: model() })

    expect(JSON.stringify(result[0])).toContain("<compaction-base>")
    expect(JSON.stringify(result[0])).toContain("old summary")
    expect(JSON.stringify(result)).not.toContain("What did we do so far?")
    expect(JSON.stringify(result)).not.toContain("old request")
    expect(JSON.stringify(result)).toContain("new request")
  })

  test("excludes the active compaction control message from compaction input", () => {
    const messages = [
      user("msg_001", "initial request"),
      compactionControl("msg_002"),
      summary("msg_003", "msg_002", "first summary"),
      user("msg_004", "follow-up"),
      compactionControl("msg_005"),
    ]

    const projected = SessionContextLayer.project({
      messages,
      excludeMessageID: "msg_005",
    })

    expect(projected.baseSummary).toBe("first summary")
    expect(projected.deltaMessages.map((msg) => msg.info.id)).toEqual(["msg_004"])
  })
})
