/**
 * Switching permission mode mid-run: already resolved tools apply the new mode on their next call, because
 * liveExecution re-reads the session before every call. Tests go through the public execute wrapped by resolveTools,
 * not runner internals.
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
import { Question } from "@merakcode/engine/question/index"
import { Bus } from "@merakcode/engine/bus/index"
import type { Provider } from "@merakcode/engine/provider/provider"
import type { PermissionMode } from "@merakcode/engine/permission/mode"
import type { Tool as AITool } from "ai"
import { Filesystem } from "@merakcode/util/filesystem"

const model = {
  id: "gpt-4",
  providerID: "openai",
  modelID: "gpt-4",
  api: { id: "gpt-4" },
} as unknown as Provider.Model

/** Not on the read-only allowlist, so ask mode always asks; only used to trigger approval, it need not succeed. */
const GRAY_PROBE = "live_perm_probe"

async function withAutoTools(
  fn: (ctx: {
    session: Session.Info
    tools: Record<string, AITool>
    tmp: string
    resolve: (permissionMode?: PermissionMode.Value) => Promise<Record<string, AITool>>
  }) => Promise<void>,
) {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
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
      expect(agent).toBeDefined()
      const assistantInfo = (await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "assistant",
        sessionID: session.id,
        mode: "build",
        agent: "build",
        path: { cwd: tmp.path, root: tmp.path },
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
      const resolve = async (permissionMode?: PermissionMode.Value) => {
        const live = await Session.get(session.id)
        const { tools } = await SessionRunner.resolveTools({
          agent: agent!,
          model,
          session: live,
          processor,
          bypassAgentCheck: false,
          messages: [{ info: user, parts: [] }],
          permissionMode: permissionMode ?? live.permissionMode,
        })
        return tools
      }
      await fn({
        session,
        tools: await resolve("auto"),
        tmp: tmp.path,
        resolve,
      })
    },
  })
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

/** Waits until a tool call either asks for approval (rejected at once) or runs to completion. */
async function outcome(running: Promise<unknown>) {
  const asked = Promise.withResolvers<PermissionNext.Request>()
  const unsub = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
    asked.resolve(event.properties)
    void PermissionNext.reply({ requestID: event.properties.id, reply: "reject" })
  })
  const settled = running.then(
    () => "ran" as const,
    () => "ran" as const,
  )
  const result = await Promise.race([asked.promise.then((req) => ({ type: "asked" as const, req })), settled])
  unsub()
  await running.catch(() => undefined)
  return result
}

test("switching from auto back to ask makes a non-read-only command in the same step ask at once", async () => {
  await withAutoTools(async ({ session, tools }) => {
    await Session.setPermissionMode({ sessionID: session.id, permissionMode: "ask" })
    const result = await outcome(executeTool(tools.bash, { command: GRAY_PROBE, description: "probe" }))
    expect(result).toMatchObject({ type: "asked", req: { permission: "bash", sessionID: session.id } })
  })
})

test("ask mode writes workspace files directly (undoable in review) but asks for dotfiles", async () => {
  await withAutoTools(async ({ session, tools, tmp }) => {
    await Session.setPermissionMode({ sessionID: session.id, permissionMode: "ask" })
    expect(await outcome(executeTool(tools.write, { filePath: path.join(tmp, "a.txt"), content: "x" }))).toBe("ran")
    expect(await Filesystem.readText(path.join(tmp, "a.txt"))).toBe("x")

    const dotfile = await outcome(executeTool(tools.write, { filePath: path.join(tmp, ".npmrc"), content: "x" }))
    expect(dotfile).toMatchObject({ type: "asked", req: { permission: "edit" } })
    expect(await Filesystem.isFile(path.join(tmp, ".npmrc"))).toBe(false)
  })
})

test("auto mode has no question tool, and the next tool resolve after switching to ask can ask", async () => {
  await withAutoTools(async ({ session, tools, resolve }) => {
    expect(tools.question).toBeUndefined()

    await Session.setPermissionMode({ sessionID: session.id, permissionMode: "ask" })
    const live = (await Session.get(session.id)).permissionMode
    const next = await resolve(live)

    expect(next.question).toBeDefined()

    const asked = Promise.withResolvers<Question.Request>()
    const unsub = Bus.subscribe(Question.Event.Asked, (event) => {
      asked.resolve(event.properties)
      void Question.reject(event.properties.id)
    })

    const running = executeTool(next.question, {
      questions: [
        {
          question: "继续吗？",
          header: "继续",
          options: [{ label: "是", description: "继续" }],
        },
      ],
    })
    const settled = running.then(
      () => "ran" as const,
      () => "ran" as const,
    )
    const result = await Promise.race([asked.promise.then((req) => ({ type: "asked" as const, req })), settled])
    unsub()

    expect(result).toMatchObject({ type: "asked" })
    if (result === "ran") throw new Error("expected question.asked")
    expect(result.req.sessionID).toBe(session.id)
    await running.catch(() => undefined)
  })
})

test("child session follows the parent mode: asks with root and source under ask, stops asking under auto", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = await Session.setPermissionMode({
        sessionID: (await Session.create({})).id,
        permissionMode: "ask",
      })
      const child = await Session.create({ parentID: parent.id, title: "查资料" })
      const user = await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID: child.id,
        agent: "explore",
        model: { providerID: "openai", modelID: "gpt-4" },
        time: { created: Date.now() },
      })
      const agent = await Agent.get("explore")
      expect(agent).toBeDefined()
      const assistantInfo = (await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "assistant",
        sessionID: child.id,
        mode: "explore",
        agent: "explore",
        path: { cwd: tmp.path, root: tmp.path },
        cost: 0,
        tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: model.id,
        providerID: model.providerID,
        parentID: user.id,
        time: { created: Date.now() },
      })) as Message.AssistantInfo
      const processor = SessionProcessor.create({
        assistantInfo,
        sessionID: child.id,
        model,
        abort: new AbortController().signal,
      })
      const { tools } = await SessionRunner.resolveTools({
        agent: agent!,
        model,
        session: child,
        processor,
        bypassAgentCheck: false,
        messages: [{ info: user, parts: [] }],
        permissionMode: await SessionRunner.modeOf(child),
        child: true,
      })
      expect(tools.subagent).toBeUndefined()

      const asked = await outcome(executeTool(tools.bash, { command: GRAY_PROBE, description: "probe" }))
      expect(asked).toMatchObject({
        type: "asked",
        req: {
          sessionID: child.id,
          root: parent.id,
          source: { sessionID: child.id, agent: "explore", title: "查资料" },
        },
      })

      await Session.setPermissionMode({ sessionID: parent.id, permissionMode: "auto" })
      expect(await outcome(executeTool(tools.bash, { command: GRAY_PROBE, description: "probe" }))).toBe("ran")
    },
  })
})

test("switching to auto re-evaluates pending approvals and releases the ones now allowed", async () => {
  await withAutoTools(async ({ session, tools }) => {
    await Session.setPermissionMode({ sessionID: session.id, permissionMode: "ask" })
    const asked = Promise.withResolvers<void>()
    const unsub = Bus.subscribe(PermissionNext.Event.Asked, () => asked.resolve())
    const running = executeTool(tools.bash, { command: GRAY_PROBE, description: "probe" })
    await asked.promise
    unsub()
    await Session.setPermissionMode({ sessionID: session.id, permissionMode: "auto" })
    await running.catch(() => undefined)
    expect(await PermissionNext.list()).toEqual([])
  })
})
