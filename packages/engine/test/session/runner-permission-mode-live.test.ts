/**
 * Switching permission mode mid-run: already resolved tools apply the new mode on their next call, because
 * liveExecution re-reads the session before every call. Tests go through the public execute wrapped by resolveTools,
 * not runner internals.
 */
import { test, expect } from "vitest"
import path from "path"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Session } from "@merakcode/engine/agent/session/index"
import { Agent } from "@merakcode/engine/agent/agent"
import { Loop } from "@merakcode/engine/agent/loop/index"
import { SessionProcessor } from "@merakcode/engine/agent/loop/processor"
import { Identifier } from "@merakcode/util/id"
import { Message } from "@merakcode/engine/agent/session/message"
import { PermissionNext } from "@merakcode/engine/agent/permission/next"
import { Question } from "@merakcode/engine/agent/session/question/index"
import { Bus } from "@merakcode/engine/infra/bus/index"
import type { Provider } from "@merakcode/engine/agent/model/provider"
import type { PermissionMode } from "@merakcode/engine/agent/permission/mode"
import type { Tool as AITool } from "ai"
import { Filesystem } from "@merakcode/util/filesystem"
import { PermissionExecution } from "@merakcode/engine/agent/permission/execution"
import { Config } from "@merakcode/engine/app/config/files/config"
import { PermissionFlush } from "@merakcode/engine/agent/permission/flush"
import type { Backend } from "@merakcode/engine/infra/sandbox/index"

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
        const { tools } = await Loop.resolveTools({
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
      const { tools } = await Loop.resolveTools({
        agent: agent!,
        model,
        session: child,
        processor,
        bypassAgentCheck: false,
        messages: [{ info: user, parts: [] }],
        permissionMode: await Loop.modeOf(child),
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

test("a command waiting only because the sandbox is not ready runs once the sandbox is set up", async () => {
  const previous = process.env.MERAKCODE_SANDBOX_MODE
  process.env.MERAKCODE_SANDBOX_MODE = "preferred"
  let ready = false
  const backend: Backend = {
    status: async () =>
      ready
        ? { status: "on", backend: "windows-account" }
        : { status: "unsupported", installable: true, reason: "needs a one-time setup" },
    setup: async () => {
      ready = true
      return { status: "on", backend: "windows-account" }
    },
    wrap: async (input) => ({
      file: input.shell,
      args:
        process.platform === "win32" && /cmd(\.exe)?$/i.test(input.shell)
          ? ["/d", "/s", "/c", input.command]
          : ["-c", input.command],
      env: input.env,
    }),
  }
  PermissionExecution.useBackendForTest(backend)
  try {
    await withAutoTools(async ({ tools, tmp }) => {
      const asked = Promise.withResolvers<void>()
      const unsub = Bus.subscribe(PermissionNext.Event.Asked, () => asked.resolve())
      const running = executeTool(tools.bash, { command: "echo hi > out.txt", description: "write" })
      await asked.promise
      unsub()
      expect(await PermissionNext.list()).toHaveLength(1)
      await PermissionExecution.install()
      expect(await PermissionNext.list()).toEqual([])
      await running
      expect((await Filesystem.readText(path.join(tmp, "out.txt"))).trim()).toBe("hi")
    })
  } finally {
    process.env.MERAKCODE_SANDBOX_MODE = previous
    PermissionExecution.useBackendForTest(undefined)
  }
})

test("a command waiting only because the sandbox is not ready runs once the sandbox is turned off", async () => {
  const previous = process.env.MERAKCODE_SANDBOX_MODE
  delete process.env.MERAKCODE_SANDBOX_MODE
  const backend: Backend = {
    status: async () => ({ status: "unsupported", installable: true, reason: "needs a one-time setup" }),
    wrap: async () => {
      throw new Error("sandbox is off")
    },
  }
  PermissionExecution.useBackendForTest(backend)
  try {
    await withAutoTools(async ({ tools, tmp, session }) => {
      PermissionFlush.init()
      const asked = Promise.withResolvers<void>()
      const unsub = Bus.subscribe(PermissionNext.Event.Asked, () => asked.resolve())
      const running = executeTool(tools.bash, { command: "echo hi > turned-off.txt", description: "write" })
      await asked.promise
      unsub()
      const released = Promise.withResolvers<void>()
      const stop = Bus.subscribe(PermissionNext.Event.Replied, (event) => {
        if (event.properties.sessionID === session.id) released.resolve()
      })
      try {
        await Config.updateProjectMerakCode({ sandbox: { mode: "off" } }, { skipDispose: true })
        await released.promise
        expect(await PermissionNext.list()).toEqual([])
        await running
        expect((await Filesystem.readText(path.join(tmp, "turned-off.txt"))).trim()).toBe("hi")
      } finally {
        stop()
      }
    })
  } finally {
    if (previous === undefined) delete process.env.MERAKCODE_SANDBOX_MODE
    else process.env.MERAKCODE_SANDBOX_MODE = previous
    PermissionExecution.useBackendForTest(undefined)
  }
})

test("setting up the sandbox does not release a file-changing command after the session is read-only", async () => {
  const previous = process.env.MERAKCODE_SANDBOX_MODE
  process.env.MERAKCODE_SANDBOX_MODE = "preferred"
  let ready = false
  PermissionExecution.useBackendForTest({
    status: async () =>
      ready
        ? { status: "on", backend: "windows-account" }
        : { status: "unsupported", installable: true, reason: "needs a one-time setup" },
    setup: async () => {
      ready = true
      return { status: "on", backend: "windows-account" }
    },
    wrap: async (input) => ({
      file: input.shell,
      args:
        process.platform === "win32" && /cmd(\.exe)?$/i.test(input.shell)
          ? ["/d", "/s", "/c", input.command]
          : ["-c", input.command],
      env: input.env,
    }),
  })
  try {
    await withAutoTools(async ({ session, tools }) => {
      const asked = Promise.withResolvers<void>()
      const unsub = Bus.subscribe(PermissionNext.Event.Asked, () => asked.resolve())
      const running = executeTool(tools.bash, { command: "echo hi > readonly.txt", description: "write" })
      await asked.promise
      unsub()
      await Session.setPermissionMode({ sessionID: session.id, permissionMode: "readonly" })
      await PermissionExecution.install()
      const settled = await Promise.race([
        running.then(
          () => "ran" as const,
          () => "failed" as const,
        ),
        new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 300)),
      ])
      expect(settled).toBe("waiting")
      const pending = await PermissionNext.list()
      expect(pending).toHaveLength(1)
      await PermissionNext.reply({ requestID: pending[0]!.id, reply: "reject" })
      await running.catch(() => undefined)
    })
  } finally {
    if (previous === undefined) delete process.env.MERAKCODE_SANDBOX_MODE
    else process.env.MERAKCODE_SANDBOX_MODE = previous
    PermissionExecution.useBackendForTest(undefined)
  }
})

test("setting up the sandbox does not release a command the user denied running outside the sandbox", async () => {
  const previous = process.env.MERAKCODE_SANDBOX_MODE
  process.env.MERAKCODE_SANDBOX_MODE = "preferred"
  let ready = false
  PermissionExecution.useBackendForTest({
    status: async () =>
      ready
        ? { status: "on", backend: "windows-account" }
        : { status: "unsupported", installable: true, reason: "needs a one-time setup" },
    setup: async () => {
      ready = true
      return { status: "on", backend: "windows-account" }
    },
    wrap: async () => {
      throw new Error("denied command must not run")
    },
  })
  try {
    await withAutoTools(async ({ tools }) => {
      PermissionFlush.init()
      const asked = Promise.withResolvers<void>()
      const unsub = Bus.subscribe(PermissionNext.Event.Asked, () => asked.resolve())
      const running = executeTool(tools.bash, { command: "echo hi > denied.txt", description: "write" })
      await asked.promise
      unsub()
      await Config.updateProjectMerakCode({ permission: { bash_unsandboxed: "deny" } }, { skipDispose: true })
      Agent.invalidate()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      await PermissionExecution.install()
      const settled = await Promise.race([
        running.then(
          () => "ran" as const,
          () => "failed" as const,
        ),
        new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 300)),
      ])
      expect(settled).toBe("waiting")
      const pending = await PermissionNext.list()
      expect(pending).toHaveLength(1)
      await PermissionNext.reply({ requestID: pending[0]!.id, reply: "reject" })
      await running.catch(() => undefined)
    })
  } finally {
    if (previous === undefined) delete process.env.MERAKCODE_SANDBOX_MODE
    else process.env.MERAKCODE_SANDBOX_MODE = previous
    PermissionExecution.useBackendForTest(undefined)
  }
})

test("setting up the sandbox does not release a risky command that is still waiting", async () => {
  const previous = process.env.MERAKCODE_SANDBOX_MODE
  process.env.MERAKCODE_SANDBOX_MODE = "preferred"
  let ready = false
  PermissionExecution.useBackendForTest({
    status: async () =>
      ready
        ? { status: "on", backend: "windows-account" }
        : { status: "unsupported", installable: true, reason: "needs a one-time setup" },
    setup: async () => {
      ready = true
      return { status: "on", backend: "windows-account" }
    },
    wrap: async () => {
      throw new Error("risky command must not run")
    },
  })
  try {
    await withAutoTools(async ({ tools }) => {
      const asked = Promise.withResolvers<void>()
      const unsub = Bus.subscribe(PermissionNext.Event.Asked, () => asked.resolve())
      const running = executeTool(tools.bash, { command: "git push", description: "publish" })
      await asked.promise
      unsub()
      await PermissionExecution.install()
      const settled = await Promise.race([
        running.then(
          () => "ran" as const,
          () => "failed" as const,
        ),
        new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 300)),
      ])
      expect(settled).toBe("waiting")
      const pending = await PermissionNext.list()
      expect(pending).toHaveLength(1)
      await PermissionNext.reply({ requestID: pending[0]!.id, reply: "reject" })
      await running.catch(() => undefined)
    })
  } finally {
    if (previous === undefined) delete process.env.MERAKCODE_SANDBOX_MODE
    else process.env.MERAKCODE_SANDBOX_MODE = previous
    PermissionExecution.useBackendForTest(undefined)
  }
})

test("switching to auto leaves a command waiting when the sandbox is still not ready", async () => {
  const previous = process.env.MERAKCODE_SANDBOX_MODE
  process.env.MERAKCODE_SANDBOX_MODE = "preferred"
  PermissionExecution.useBackendForTest({
    status: async () => ({ status: "unsupported", installable: true, reason: "needs a one-time setup" }),
    wrap: async () => {
      throw new Error("not set up")
    },
  })
  try {
    await withAutoTools(async ({ session, tools }) => {
      await Session.setPermissionMode({ sessionID: session.id, permissionMode: "ask" })
      const asked = Promise.withResolvers<void>()
      const unsub = Bus.subscribe(PermissionNext.Event.Asked, () => asked.resolve())
      const running = executeTool(tools.bash, { command: "echo hi > stay.txt", description: "write" })
      await asked.promise
      unsub()
      await Session.setPermissionMode({ sessionID: session.id, permissionMode: "auto" })
      const settled = await Promise.race([
        running.then(
          () => "ran" as const,
          () => "failed" as const,
        ),
        new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 300)),
      ])
      expect(settled).toBe("waiting")
      const pending = await PermissionNext.list()
      expect(pending).toHaveLength(1)
      await PermissionNext.reply({ requestID: pending[0]!.id, reply: "reject" })
      await running.catch(() => undefined)
    })
  } finally {
    if (previous === undefined) delete process.env.MERAKCODE_SANDBOX_MODE
    else process.env.MERAKCODE_SANDBOX_MODE = previous
    PermissionExecution.useBackendForTest(undefined)
  }
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
