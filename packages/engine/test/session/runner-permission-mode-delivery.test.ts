import fs from "node:fs/promises"
import { fileURLToPath } from "node:url"
/**
 * Ordinary prompt and shell inputs preserve the explicitly selected root permission level.
 * Live asks after setMode during a run are covered in runner-permission-mode-live.test.ts.
 */
import { test, expect } from "vitest"
import path from "path"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { tmpdir, selectPermissionLevel } from "../fixture/fixture"
import { Session } from "@merakcode/engine/agent/session/index"
import { Agent } from "@merakcode/engine/agent/agent"
import { Loop } from "@merakcode/engine/agent/loop/index"
import { SessionProcessor } from "@merakcode/engine/agent/loop/processor"
import { Identifier } from "@merakcode/util/id"
import { Message } from "@merakcode/engine/agent/session/message"
import { PermissionNext } from "@merakcode/engine/agent/permission/next"
import { Bus } from "@merakcode/engine/infra/bus/index"
import type { Provider } from "@merakcode/engine/agent/model/provider"
import type { Tool as AITool } from "ai"
import { Filesystem } from "@merakcode/util/filesystem"

const model = {
  id: "gpt-4",
  providerID: "openai",
  modelID: "gpt-4",
  api: { id: "gpt-4" },
} as unknown as Provider.Model

async function autoSession() {
  const session = await selectPermissionLevel({
    sessionID: (await Session.create({})).id,
    permissionLevel: "fullTakeover",
  })
  const user = await Session.updateInfo({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID: session.id,
    agent: "build",
    permissionLevel: "fullTakeover",
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
  const { tools } = await Loop.resolveTools({
    agent,
    model,
    session: live,
    processor,
    bypassAgentCheck: false,
    messages: [{ info: user, parts: [] }],
    permissionLevel: live.permissionLevel,
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
      expect((await Session.get(session.id)).permissionLevel).toBe("fullTakeover")

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

test("a stale prompt hint preserves the selected fullTakeover level and existing tools", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const { session, user, agent, processor } = await autoSession()
      const tools = await resolveTools(session.id, agent, user, processor)
      expect((await Session.get(session.id)).permissionLevel).toBe("fullTakeover")

      // Ordinary messages cannot select a permission level.
      await Loop.prompt({
        sessionID: session.id,
        agent: "build",
        permissionLevel: "autoApprove",
        noReply: true,
        model: { providerID: "openai", modelID: "gpt-4" },
        parts: [{ type: "text", text: "delivery probe" }],
      })

      expect((await Session.get(session.id)).permissionLevel).toBe("fullTakeover")

      // The resolved tools continue to use the explicit root selection.
      const filePath = path.join(tmp.path, "prompt-writeback.txt")
      const { outcome } = await raceWriteAsk(tools, session.id, filePath)
      expect(outcome).toBe("ran")
      expect(await Filesystem.readText(filePath)).toBe("x")
    },
  })
})

test("prompt without a mode preserves the current explicitly selected mode", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const { session } = await autoSession()
      await Loop.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        model: { providerID: "openai", modelID: "gpt-4" },
        parts: [{ type: "text", text: "no mode" }],
      })
      expect((await Session.get(session.id)).permissionLevel).toBe("fullTakeover")
    },
  })
})

test("a stale shell hint preserves the selected root level and previously resolved tools", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const { session, user, agent, processor } = await autoSession()
      const tools = await resolveTools(session.id, agent, user, processor)
      await Loop.shell({
        sessionID: session.id,
        agent: "build",
        permissionLevel: "autoApprove",
        model: { providerID: "openai", modelID: "gpt-4" },
        command: "echo delivery-shell",
      })
      const live = await Session.get(session.id)
      const messages = await Session.messages({ sessionID: session.id })
      const lastUser = [...messages].reverse().find((msg) => msg.info.role === "user")
      if (lastUser?.info.role !== "user") throw new Error("expected user message")
      expect(lastUser.info.permissionLevel).toBe("fullTakeover")
      expect(live.permissionLevel).toBe("fullTakeover")

      // With no default ask, write runs without a permission card.
      const filePath = path.join(tmp.path, "after-shell.txt")
      const { outcome } = await raceWriteAsk(tools, session.id, filePath)
      expect(outcome).toBe("ran")
      expect(await Filesystem.readText(filePath)).toBe("x")
    },
  })
})

test("a manual switch while a real message hook waits survives prompt preparation", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (directory) => {
      await fs.mkdir(path.join(directory, ".merakcode/node_modules"), { recursive: true })
      await fs.symlink(
        path.dirname(fileURLToPath(import.meta.resolve("zod"))),
        path.join(directory, ".merakcode/node_modules/zod"),
        process.platform === "win32" ? "junction" : "dir",
      )
      await Filesystem.write(
        path.join(directory, ".merakcode/plugin/mode-gate.ts"),
        `import fs from "node:fs/promises"
      import path from "node:path"
      export const gate = async ({directory}) => ({"chat.message": async () => {
        await fs.writeFile(path.join(directory, "mode-hook-ready"), "ready")
        while (!await fs.access(path.join(directory, "mode-hook-release")).then(() => true, () => false)) await new Promise(resolve => setTimeout(resolve, 10))
      }})`,
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ title: "Prompt mode race" })
      const pending = Loop.prompt({
        sessionID: session.id,
        permissionLevel: "fullTakeover",
        noReply: true,
        model: { providerID: "openai", modelID: "gpt-4" },
        parts: [{ type: "text", text: "Prepare message" }],
      })
      try {
        await expect
          .poll(() => Filesystem.isFile(path.join(tmp.path, "mode-hook-ready")), { timeout: 10000 })
          .toBe(true)
        await selectPermissionLevel({ sessionID: session.id, permissionLevel: "ask" })
      } finally {
        await Filesystem.write(path.join(tmp.path, "mode-hook-release"), "release")
      }
      await pending
      expect((await Session.get(session.id)).permissionLevel).toBe("ask")
    },
  })
})
