/**
 * prompt and shell write their permission mode back to the session, which is the source of truth.
 * Live asks after setPermissionMode during a run are covered in runner-permission-mode-live.test.ts.
 */
import { test, expect } from "vitest"
import path from "path"
import { Instance } from "@merakcode/engine/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Session } from "@merakcode/engine/session/index"
import { Agent } from "@merakcode/engine/agent/agent"
import { SessionRunner } from "@merakcode/engine/session/runner"
import { SessionProcessor } from "@merakcode/engine/session/processor"
import { Identifier } from "@merakcode/util/id"
import { Message } from "@merakcode/engine/session/message"
import { PermissionNext } from "@merakcode/engine/permission/next"
import { Bus } from "@merakcode/engine/bus/index"
import type { Provider } from "@merakcode/engine/provider/provider"
import type { Tool as AITool } from "ai"
import { Filesystem } from "@merakcode/util/filesystem"

const model = {
  id: "gpt-4",
  providerID: "openai",
  modelID: "gpt-4",
  api: { id: "gpt-4" },
} as unknown as Provider.Model

async function autoSession() {
  const session = await Session.setPermissionMode({
    sessionID: (await Session.create({})).id,
    permissionMode: "auto",
  })
  const user = await Session.updateInfo({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID: session.id,
    agent: "build",
    permissionMode: "auto",
    model: { providerID: "openai", modelID: "gpt-4" },
    time: { created: Date.now() },
  })
  const agent = await Agent.get("build")
  if (!agent) throw new Error("build agent missing")
  const assistantInfo = (await Session.updateInfo({
    id: Identifier.ascending("message"),
    role: "assistant",
    sessionID: session.id,
    mode: "build",
    agent: "build",
    path: { cwd: Instance.directory, root: Instance.worktree },
    cost: 0,
    tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: model.id,
    providerID: model.providerID,
    parentID: user.id,
    time: { created: Date.now() },
  })) as Message.AssistantInfo
  const processor = SessionProcessor.create({
    assistantInfo,
    sessionID: session.id,
    model,
    abort: new AbortController().signal,
  })
  return { session, user, agent, processor }
}

async function resolveTools(
  sessionID: string,
  agent: NonNullable<Awaited<ReturnType<typeof Agent.get>>>,
  user: Message.Info,
  processor: SessionProcessor.Info,
) {
  const live = await Session.get(sessionID)
  const { tools } = await SessionRunner.resolveTools({
    agent,
    model,
    session: live,
    processor,
    bypassAgentCheck: false,
    messages: [{ info: user, parts: [] }],
    permissionMode: live.permissionMode,
  })
  return tools
}

function executeTool(tool: AITool | undefined, args: Record<string, unknown>) {
  expect(tool).toBeDefined()
  expect(tool!.execute).toBeDefined()
  return tool!.execute!(args, {
    toolCallId: Identifier.ascending("part"),
    abortSignal: new AbortController().signal,
    messages: [],
    context: {},
  })
}

/**
 * Runs one write and reports whether it raised a permission ask or actually ran.
 *
 * There is no default ask any more: write runs directly unless something requests an ask. These tests target the
 * mode write-back itself: the tool ctx re-reads the session on every execute, so `asked` and the written file prove
 * the tools see the written-back state.
 */
async function raceWriteAsk(tools: Record<string, AITool>, sessionID: string, filePath: string) {
  const asked = Promise.withResolvers<PermissionNext.Request>()
  const unsub = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
    asked.resolve(event.properties)
    void PermissionNext.reply({ requestID: event.properties.id, reply: "reject" })
  })
  const running = executeTool(tools.write, { filePath, content: "x" })
  const settled = running.then(
    () => "ran" as const,
    () => "ran" as const,
  )
  const outcome = await Promise.race([asked.promise.then((req) => ({ type: "asked" as const, req })), settled])
  unsub()
  await running.catch(() => undefined)
  return { outcome, sessionID }
}

test("control: while the session stays auto, the resolved write tool does not ask", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const { session, user, agent, processor } = await autoSession()
      const tools = await resolveTools(session.id, agent, user, processor)
      expect((await Session.get(session.id)).permissionMode).toBe("auto")

      let asked = false
      const unsub = Bus.subscribe(PermissionNext.Event.Asked, () => {
        asked = true
      })
      const filePath = path.join(tmp.path, "still-auto.txt")
      await executeTool(tools.write, { filePath, content: "ok" })
      unsub()
      expect(asked).toBe(false)
      expect(await Filesystem.readText(filePath)).toBe("ok")
    },
  })
})

test("prompt with ask overrides a leftover auto session mode, and write then runs under ask", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const { session, user, agent, processor } = await autoSession()
      const tools = await resolveTools(session.id, agent, user, processor)
      expect((await Session.get(session.id)).permissionMode).toBe("auto")

      // Like an Agent submit: the prompt carries the mode before the client's setPermissionMode has run.
      await SessionRunner.prompt({
        sessionID: session.id,
        agent: "build",
        permissionMode: "ask",
        noReply: true,
        model: { providerID: "openai", modelID: "gpt-4" },
        parts: [{ type: "text", text: "delivery probe" }],
      })

      expect((await Session.get(session.id)).permissionMode).toBe("ask")

      // The previously resolved tools re-read the session on execute and see the written-back ask mode. Nothing
      // requests an ask for write, so it runs without a permission card.
      const filePath = path.join(tmp.path, "prompt-writeback.txt")
      const { outcome } = await raceWriteAsk(tools, session.id, filePath)
      expect(outcome).toBe("ran")
      expect(await Filesystem.readText(filePath)).toBe("x")
    },
  })
})

test("prompt without permissionMode writes back the default ask, replacing a leftover auto", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const { session } = await autoSession()
      await SessionRunner.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        model: { providerID: "openai", modelID: "gpt-4" },
        parts: [{ type: "text", text: "no mode" }],
      })
      expect((await Session.get(session.id)).permissionMode).toBe("ask")
    },
  })
})

test("shell with ask writes ask back to the session, and previously resolved tools follow it", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const { session, user, agent, processor } = await autoSession()
      const tools = await resolveTools(session.id, agent, user, processor)
      await SessionRunner.shell({
        sessionID: session.id,
        agent: "build",
        permissionMode: "ask",
        model: { providerID: "openai", modelID: "gpt-4" },
        command: "echo delivery-shell",
      })
      const live = await Session.get(session.id)
      const messages = await Session.messages({ sessionID: session.id })
      const lastUser = [...messages].reverse().find((msg) => msg.info.role === "user")
      if (lastUser?.info.role !== "user") throw new Error("expected user message")
      expect(lastUser.info.permissionMode).toBe("ask")
      expect(live.permissionMode).toBe("ask")

      // With no default ask, write runs without a permission card.
      const filePath = path.join(tmp.path, "after-shell.txt")
      const { outcome } = await raceWriteAsk(tools, session.id, filePath)
      expect(outcome).toBe("ran")
      expect(await Filesystem.readText(filePath)).toBe("x")
    },
  })
})
