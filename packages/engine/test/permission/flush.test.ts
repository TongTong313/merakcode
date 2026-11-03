/**
 * PermissionFlush: after a config change, pending permissions that the new rules allow are resolved automatically
 * (parallel tool calls and subagents).
 */
import { test, expect } from "vitest"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Session } from "@merakcode/engine/agent/session/index"
import { Agent } from "@merakcode/engine/agent/agent"
import { Loop } from "@merakcode/engine/agent/loop/index"
import { PermissionNext } from "@merakcode/engine/agent/permission/next"
import { Config } from "@merakcode/engine/app/config/files/config"
import { Identifier } from "@merakcode/util/id"
import { Message } from "@merakcode/engine/agent/session/message"
import { InstanceBootstrap } from "@merakcode/engine/app/project/bootstrap"

async function waitForFlush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

test("legacy config allows cannot release parallel ask approvals", async () => {
  await using tmp = await tmpdir({ git: true, config: { permission: { write: "ask" } } })
  await Instance.provide({
    directory: tmp.path,
    init: InstanceBootstrap,
    fn: async () => {
      // Do not put write:ask in session.permission: at the end of the chain it would shadow the project config's allow
      // and flush would always re-evaluate to ask.
      const session = await Session.create({})

      const agent = await Agent.get("build")
      expect(agent).toBeDefined()
      const ruleset = Loop.buildToolExecutionRuleset({ agent: agent!, session })
      expect(PermissionNext.evaluate("write", "src/foo.ts", ruleset).action).toBe("ask")

      const sessionID = session.id
      const user = await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID,
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-4" },
        time: { created: Date.now() },
      })
      const assistant = (await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "assistant",
        sessionID,
        mode: "build",
        agent: "build",
        path: { cwd: tmp.path, root: tmp.path },
        cost: 0,
        tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "gpt-4",
        providerID: "openai",
        parentID: user.id,
        time: { created: Date.now() },
      })) as Message.AssistantInfo

      const baseAsk = {
        sessionID,
        permission: "write" as const,
        patterns: ["src/foo.ts"],
        metadata: { filepath: "src/foo.ts" },
        ruleset,
        tool: { messageID: assistant.id, callID: "tc0" },
      }

      const p1 = PermissionNext.ask({ ...baseAsk, tool: { messageID: assistant.id, callID: "tc1" } })
      const p2 = PermissionNext.ask({ ...baseAsk, tool: { messageID: assistant.id, callID: "tc2" } })
      const p3 = PermissionNext.ask({ ...baseAsk, tool: { messageID: assistant.id, callID: "tc3" } })

      await expect.poll(async () => (await PermissionNext.list()).length).toBe(3)

      await Config.updateProjectMerakCode({ permission: { write: "allow" } }, { skipDispose: true })
      Agent.invalidate()
      await waitForFlush()

      expect(await PermissionNext.list()).toHaveLength(3)
      for (const request of await PermissionNext.list())
        await PermissionNext.reply({ requestID: request.id, reply: "once" })
      await Promise.all([p1, p2, p3])
      expect(await PermissionNext.list()).toEqual([])
    },
  })
})

test("child session: buildToolExecutionRuleset ends with subagent deny (asserts the ruleset since ask throws synchronously)", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    init: InstanceBootstrap,
    fn: async () => {
      const parent = await Session.create({})
      const childCreated = await Session.create({ parentID: parent.id })
      await Session.update(childCreated.id, (s) => {
        s.permission = PermissionNext.fromConfig({ subagent: "allow" })
      })
      const child = (await Session.get(childCreated.id))!
      expect(child.parentID).toBe(parent.id)

      const agent = await Agent.get("build")
      expect(agent).toBeDefined()
      const ruleset = Loop.buildToolExecutionRuleset({ agent: agent!, session: child })
      expect(PermissionNext.evaluate("subagent", "general", ruleset).action).toBe("deny")
    },
  })
})

test("legacy read allows cannot answer an ask approval", async () => {
  await using tmp = await tmpdir({ git: true, config: { permission: { read: "ask" } } })
  await Instance.provide({
    directory: tmp.path,
    init: InstanceBootstrap,
    fn: async () => {
      const session = await Session.create({})
      const agent = await Agent.get("build")
      expect(agent).toBeDefined()
      const ruleset = Loop.buildToolExecutionRuleset({ agent: agent!, session })
      expect(PermissionNext.evaluate("read", "README.md", ruleset).action).toBe("ask")

      const sessionID = session.id
      const user = await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID,
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-4" },
        time: { created: Date.now() },
      })
      const assistant = (await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "assistant",
        sessionID,
        mode: "build",
        agent: "build",
        path: { cwd: tmp.path, root: tmp.path },
        cost: 0,
        tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "gpt-4",
        providerID: "openai",
        parentID: user.id,
        time: { created: Date.now() },
      })) as Message.AssistantInfo

      const p = PermissionNext.ask({
        sessionID,
        permission: "read",
        patterns: ["README.md"],
        metadata: { filepath: "README.md" },
        ruleset,
        tool: { messageID: assistant.id, callID: "tc1" },
      })

      await expect.poll(async () => (await PermissionNext.list()).length).toBe(1)

      await Config.updateProjectMerakCode({ permission: { read: "allow" } }, { skipDispose: true })
      Agent.invalidate()
      await waitForFlush()

      expect(await PermissionNext.list()).toHaveLength(1)
      await PermissionNext.reply({ requestID: (await PermissionNext.list())[0]!.id, reply: "once" })
      await p
      expect(await PermissionNext.list()).toEqual([])
    },
  })
})

test("glob=allow alone does not resolve a pending read ask", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    init: InstanceBootstrap,
    fn: async () => {
      const created = await Session.create({})
      await Session.update(created.id, (s) => {
        s.permission = PermissionNext.fromConfig({ read: "ask" })
      })
      const session = (await Session.get(created.id))!

      const agent = await Agent.get("build")
      expect(agent).toBeDefined()
      const ruleset = Loop.buildToolExecutionRuleset({ agent: agent!, session })

      const sessionID = session.id
      const user = await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID,
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-4" },
        time: { created: Date.now() },
      })
      const assistant = (await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "assistant",
        sessionID,
        mode: "build",
        agent: "build",
        path: { cwd: tmp.path, root: tmp.path },
        cost: 0,
        tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "gpt-4",
        providerID: "openai",
        parentID: user.id,
        time: { created: Date.now() },
      })) as Message.AssistantInfo

      const p = PermissionNext.ask({
        sessionID,
        permission: "read",
        patterns: ["**/README.md"],
        metadata: { filepath: "README.md" },
        ruleset,
        tool: { messageID: assistant.id, callID: "tc1" },
      })

      await Config.updateProjectMerakCode({ permission: { glob: "allow" } }, { skipDispose: true })
      Agent.invalidate()
      await waitForFlush()

      await expect.poll(async () => (await PermissionNext.list()).length).toBe(1)
      await PermissionNext.reply({ requestID: (await PermissionNext.list())[0]!.id, reply: "once" })
      await p
    },
  })
})
