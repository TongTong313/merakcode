import { expect, test } from "vitest"
import type { Agent } from "../../src/agent/agent"
import type { Provider } from "../../src/agent/model/provider"
import { Instance } from "../../src/infra/project/instance"
import { Session } from "../../src/agent/session"
import { Message } from "../../src/agent/session/message"
import { SessionContextView } from "../../src/agent/context/context-view"
import { Todo } from "../../src/agent/session/todo"
import { create } from "../../src/app/task/collaboration/store"
import { tmpdir } from "../fixture/fixture"

const model = {
  id: "test-model",
  providerID: "test",
  name: "Test Model",
  limit: { context: 128_000, input: 0, output: 8_192 },
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

/** What the model is sent for a one-message conversation, and the messages as stored */
async function view(sessionID: string) {
  const user = {
    id: "msg_001",
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "build",
    model: { providerID: "test", modelID: "test-model" },
  } as Message.UserInfo
  const messages: Message.FullMsg[] = [
    {
      info: user,
      parts: [{ id: "prt_001", sessionID, messageID: user.id, type: "text", text: "@小红 做登录" }],
    },
  ]
  const built = await SessionContextView.build({
    messages,
    sessionID,
    user,
    agent: { id: "build", mode: "primary", prompt: "Agent prompt" } as Agent.Info,
    model,
    step: 1,
  })
  return {
    sent: JSON.stringify(built.messages),
    stored: JSON.stringify(built.sessionMessages),
    messages: built.messages,
  }
}

test("each turn the leader is told who it is, who the members are with their duties, and the todo", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ metadata: { group: true } })
      await create(session.id, {
        leader: { name: "小主", role: "交付经理", duty: "负责分派，也可以自己干活" },
        seats: [
          { name: "小红", role: "产品经理", duty: "负责登录，不改支付", product: "claude" },
          { name: "abc", product: "codex" },
        ],
      })
      await Todo.update({
        sessionID: session.id,
        todos: [{ id: "t1", content: "@小红 做登录 (src/auth/**)", status: "pending", priority: "high" }],
      })
      const { sent, stored } = await view(session.id)
      for (const line of [
        "This conversation is a group chat. You are 小主 (MerakCode), the leader. Your role: 交付经理.",
        "Your duty:\\n负责分派，也可以自己干活",
        "- 小红 (Claude Code, 产品经理)\\n  Duty: 负责登录，不改支付",
        "- abc (Codex)",
        "Todo:\\n- [ ] @小红 做登录 (src/auth/**) (id: t1)",
      ])
        expect(sent).toContain(line)
      expect(stored).not.toContain("group chat")
    },
  })
})

test("an ordinary conversation gets no group context", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      expect((await view(session.id)).sent).not.toContain("group chat")
    },
  })
})

test("the todo and changed files come after the history, so a todo change leaves everything before them as it was", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ metadata: { group: true } })
      await create(session.id, { leader: { name: "小主" }, seats: [{ name: "小红", product: "claude" }] })
      const before = await view(session.id)
      await Todo.update({
        sessionID: session.id,
        todos: [{ id: "t1", content: "@小红 做登录 (src/auth/**)", status: "in_progress", priority: "high" }],
      })
      const after = await view(session.id)
      expect(after.messages.slice(0, -1)).toEqual(before.messages.slice(0, -1))
      const [first, last] = [JSON.stringify(after.messages[0]), JSON.stringify(after.messages.at(-1))]
      expect(first).toContain("- 小红 (Claude Code)")
      expect(first).not.toContain("Todo:")
      expect(last).toContain("- [-] @小红 做登录 (src/auth/**) (id: t1)")
      expect(after.stored).not.toContain("(id: t1)")
    },
  })
})
