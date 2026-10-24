import { expect, test } from "vitest"
import { Identifier } from "@merakcode/util/id"
import { Instance } from "@merakcode/engine/project/instance"
import { Session } from "@merakcode/engine/session/index"
import type { Message } from "@merakcode/engine/session/message"
import { SessionMemory } from "@merakcode/engine/session-memory/session-memory"
import { tmpdir } from "../fixture/fixture"

test("session memory works in a background child, which does not count as the conversation running", async () => {
  // No model is reachable, so the extraction itself fails; the child it works in is created first
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
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
      SessionMemory.schedule({ session, assistant, model: user.model, tokens: 20_000 })
      await SessionMemory.waitForExtraction(session.id)
      const children = await Session.children(session.id)
      expect(children.map((child) => [child.title, child.metadata])).toEqual([["session memory", { background: true }]])
    },
  })
})
