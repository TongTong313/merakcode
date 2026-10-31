import { expect, test } from "vitest"
import { Identifier } from "@merakcode/util/id"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Session } from "@merakcode/engine/agent/session/index"
import type { Message } from "@merakcode/engine/agent/session/message"
import { AutoDream } from "@merakcode/engine/agent/memory/dream/dream"
import { tmpdir } from "../fixture/fixture"

test("memory consolidation works in a background child, which does not count as the conversation running", async () => {
  // No model is reachable, so consolidation itself fails; the child it works in is created first
  await using tmp = await tmpdir({
    git: true,
    config: { memory: { auto_dream: true, dream_min_hours: 0.0001, dream_min_sessions: 1 } },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Session.create({})
      const session = await Session.create({})
      const user = (await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID: session.id,
        agent: "build",
        model: { providerID: "missing", modelID: "missing" },
        time: { created: Date.now() },
      })) as Message.UserInfo
      const assistant = (await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "assistant",
        sessionID: session.id,
        mode: "build",
        agent: "build",
        path: { cwd: tmp.path, root: tmp.path },
        cost: 0,
        tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "missing",
        providerID: "missing",
        parentID: user.id,
        time: { created: Date.now() },
      })) as Message.AssistantInfo
      AutoDream.schedule({ session, assistant, model: user.model })
      await AutoDream.drain()
      const children = await Session.children(session.id)
      expect(children.map((child) => child.metadata)).toEqual([{ background: true }])
    },
  })
})
