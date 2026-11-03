/**
 * Switching permission mode mid-run: already resolved tools apply the new mode on their next call, because
 * liveExecution re-reads the session before every call. Tests go through the public execute wrapped by resolveTools,
 * not runner internals.
 */
import { test, expect } from "vitest"
import path from "path"
import fs from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { tmpdir, selectPermissionLevel } from "../fixture/fixture"
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
import type { PermissionLevel } from "@merakcode/engine/agent/permission/level"
import type { Tool as AITool } from "ai"
import { Filesystem } from "@merakcode/util/filesystem"
import { PermissionExecution } from "@merakcode/engine/agent/permission/execution"
import { Config } from "@merakcode/engine/app/config/files/config"
import { PermissionFlush } from "@merakcode/engine/agent/permission/flush"
import { BashJobStore } from "@merakcode/engine/agent/tools/bash-background"
import type { Backend } from "@merakcode/engine/infra/sandbox/index"

const model = {
  id: "gpt-4",
  providerID: "openai",
  modelID: "gpt-4",
  api: { id: "gpt-4" },
} as unknown as Provider.Model

/** Not on the read-only allowlist, so ask mode always asks; only used to trigger approval, it need not succeed. */
const GRAY_PROBE = "live_perm_probe"

test.each([
  ["ask", "autoApprove"],
  ["autoApprove", "ask"],
] as const)("a pending real tool keeps its approval id across %s to %s", async (original, latest) => {
  await withAutoTools(async ({ session, tools, tmp }) => {
    await selectPermissionLevel({ sessionID: session.id, permissionLevel: original })
    const running = Promise.resolve(
      executeTool(tools.write, { filePath: path.join(tmp, "pending.txt"), content: "CHANGED" }),
    )
    running.catch(() => {})
    try {
      await expect.poll(async () => (await PermissionNext.list()).length).toBe(1)
      const originalID = (await PermissionNext.list())[0]!.id
      await selectPermissionLevel({ sessionID: session.id, permissionLevel: latest })
      expect((await PermissionNext.list())[0]?.id).toBe(originalID)
      expect(await Filesystem.isFile(path.join(tmp, "pending.txt"))).toBe(false)
    } finally {
      for (const request of await PermissionNext.list())
        await PermissionNext.reply({ requestID: request.id, reply: "reject" })
      await running.catch(() => {})
    }
  })
})

test("an unconfirmed cancellation blocks new work until the original operation actually settles", async () => {
  await withAutoTools(
    async ({ session, tools, tmp }) => {
      const first = Promise.resolve(executeTool(tools.fixture_wait, {})).catch(() => undefined)
      let second: Promise<unknown> | undefined
      const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
        void PermissionNext.reply({ requestID: event.properties.id, reply: "once" })
      })
      try {
        await expect.poll(() => Filesystem.isFile(path.join(tmp, "started")), { timeout: 10000 }).toBe(true)
        await expect(selectPermissionLevel({ sessionID: session.id, permissionLevel: "ask" })).rejects.toMatchObject({
          name: "ModeOperationPendingError",
        })
        second = Promise.resolve(executeTool(tools.fixture_wait, {}))
        await expect(second).rejects.toMatchObject({ name: "ModeOperationPendingError" })
        expect(await Filesystem.readText(path.join(tmp, "started"))).toBe("1")
      } finally {
        unsubscribe()
        await Filesystem.write(path.join(tmp, "release"), "released")
        await first
        await second?.catch(() => undefined)
      }
    },
    undefined,
    async (directory) => {
      const plugins = path.join(directory, ".merakcode", "plugin")
      await fs.mkdir(plugins, { recursive: true })
      await Filesystem.write(
        path.join(plugins, "wait.ts"),
        `
      import fs from "node:fs"
      import path from "node:path"
      export default { id:"wait-fixture", server:async ({directory})=>({tool:{fixture_wait:{
        description:"Wait for an external release receipt",args:{},execute:async()=>{
          const file=path.join(directory,"started")
          const count=fs.existsSync(file)?Number(fs.readFileSync(file,"utf8"))+1:1
          fs.writeFileSync(file,String(count))
          if(count>1)return "Second operation ran"
          while(!fs.existsSync(path.join(directory,"release"))) await new Promise(resolve=>setTimeout(resolve,5))
          return "Released"
        }
      }}}) }
    `,
      )
    },
  )
}, 30000)

test("a manually approved process survives matching permission switches and reports its real stop", async () => {
  await withAutoTools(async ({ session, tools, tmp }) => {
    await selectPermissionLevel({ sessionID: session.id, permissionLevel: "ask" })
    let approvals = 0
    const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
      approvals++
      void PermissionNext.reply({ requestID: event.properties.id, reply: "once" })
    })
    let jobID: string | undefined
    try {
      const output = (await executeTool(tools.bash_background, {
        command: `node -e "require('fs').writeFileSync('manual-ready','ready');setInterval(()=>{},1000)"`,
        description: "Run a manually approved process",
      })) as { metadata: { jobId: string } }
      jobID = output.metadata.jobId
      await expect.poll(() => Filesystem.isFile(path.join(tmp, "manual-ready"))).toBe(true)
      await selectPermissionLevel({ sessionID: session.id, permissionLevel: "ask" })
      expect(BashJobStore.get(jobID)?.status).toBe("running")
      await selectPermissionLevel({ sessionID: session.id, permissionLevel: "autoApprove" })
      expect(BashJobStore.get(jobID)?.status).toBe("running")
      expect(approvals).toBe(1)
    } finally {
      unsubscribe()
      if (jobID) {
        await BashJobStore.stop(jobID)
        expect(BashJobStore.get(jobID)?.status).toBe("stopped")
      }
    }
  })
})

test("switching to plan sends cancellation to a running MCP call and prevents its effect", async () => {
  await using markers = await tmpdir()
  await withAutoTools(
    async ({ session, tools, tmp }) => {
      const running = Promise.resolve(executeTool(tools.mode_mutate, {})).catch(() => {})
      try {
        await expect.poll(() => Filesystem.isFile(path.join(markers.path, "started"))).toBe(true)
        await selectPermissionLevel({ sessionID: session.id, permissionLevel: "ask" })
        await running
        await expect.poll(() => Filesystem.isFile(path.join(markers.path, "cancelled"))).toBe(true)
        await Filesystem.write(path.join(markers.path, "release"), "released")
        expect(await Filesystem.isFile(path.join(markers.path, "effect"))).toBe(false)
        expect((await Session.get(session.id)).permissionLevel).toBe("ask")
        await Filesystem.write(path.join(tmp, "allowed.txt"), "allowed")
        const approveRead = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
          void PermissionNext.reply({
            requestID: event.properties.id,
            decisionRevision: event.properties.decisionRevision,
            reply: "once",
          })
        })
        try {
          expect(await executeTool(tools.read, { filePath: path.join(tmp, "allowed.txt") })).toBeDefined()
        } finally {
          approveRead()
        }
      } finally {
        await Filesystem.write(path.join(markers.path, "release"), "released")
        await running
      }
    },
    {
      mcp: {
        mode: {
          type: "local",
          enabled: true,
          command: [
            process.execPath,
            fileURLToPath(new URL("../fixture/mcp-mode-server.mjs", import.meta.url)),
            markers.path,
          ],
        },
      },
    },
  )
})

test("switching to plan stops a background process after its launching tool returned", async () => {
  await withAutoTools(async ({ session, tools }) => {
    const output = (await executeTool(tools.bash_background, {
      command: 'node -e "setInterval(() => {}, 1000)"',
      description: "Background mode probe",
    })) as { metadata: { jobId: string } }
    const job = BashJobStore.get(output.metadata.jobId)
    expect(job?.status).toBe("running")
    await selectPermissionLevel({ sessionID: session.id, permissionLevel: "ask" })
    expect(BashJobStore.get(output.metadata.jobId)?.status).toBe("stopped")
  })
}, 10_000)

test("switching an active command to plan stops that operation without restarting the session", async () => {
  await withAutoTools(async ({ session, tools, tmp }) => {
    const ready = path.join(tmp, "ready.txt")
    const code = "require('node:fs').writeFileSync('ready.txt', 'ready'); setInterval(() => {}, 1000)"
    const running = executeTool(tools.bash, {
      command: `node -e ${JSON.stringify(code)}`,
      description: "Wait for mode change",
    })
    await expect.poll(() => Filesystem.isFile(ready), { timeout: 5000 }).toBe(true)
    const switchedAt = performance.now()
    await selectPermissionLevel({ sessionID: session.id, permissionLevel: "ask" })
    expect(performance.now() - switchedAt).toBeLessThan(3000)
    await running.catch(() => undefined)
    expect((await Session.get(session.id)).permissionLevel).toBe("ask")
  })
}, 15_000)

async function withAutoTools(
  fn: (ctx: {
    session: Session.Info
    tools: Record<string, AITool>
    tmp: string
    resolve: (permissionLevel?: PermissionLevel.Value) => Promise<Record<string, AITool>>
  }) => Promise<void>,
  config?: Partial<Config.Info>,
  init?: (directory: string) => Promise<void>,
) {
  await using tmp = await tmpdir({ git: true, config: { agent: { build: { deferTools: [] } }, ...config }, init })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
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
      const resolve = async (permissionLevel?: PermissionLevel.Value) => {
        const live = await Session.get(session.id)
        const { tools } = await Loop.resolveTools({
          agent: agent!,
          model,
          session: live,
          processor,
          bypassAgentCheck: false,
          messages: [{ info: user, parts: [] }],
          permissionLevel: permissionLevel ?? live.permissionLevel,
        })
        return tools
      }
      await fn({
        session,
        tools: await resolve("fullTakeover"),
        tmp: tmp.path,
        resolve,
      })
    },
  })
}

function executeTool(tool: AITool | undefined, args: Record<string, unknown>, signal = new AbortController().signal) {
  expect(tool).toBeDefined()
  expect(tool!.execute).toBeDefined()
  return tool!.execute!(args, {
    toolCallId: Identifier.ascending("part"),
    abortSignal: signal,
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
    await selectPermissionLevel({ sessionID: session.id, permissionLevel: "autoApprove" })
    const result = await outcome(executeTool(tools.bash, { command: GRAY_PROBE, description: "probe" }))
    expect(result).toMatchObject({ type: "asked", req: { permission: "bash", sessionID: session.id } })
  })
})

test("ask mode asks for workspace files and dotfiles", async () => {
  await withAutoTools(async ({ session, tools, tmp }) => {
    await selectPermissionLevel({ sessionID: session.id, permissionLevel: "autoApprove" })
    await selectPermissionLevel({ sessionID: session.id, permissionLevel: "ask" })
    expect(await outcome(executeTool(tools.write, { filePath: path.join(tmp, "a.txt"), content: "x" }))).toMatchObject({
      type: "asked",
    })
    expect(await Filesystem.isFile(path.join(tmp, "a.txt"))).toBe(false)

    const dotfile = await outcome(executeTool(tools.write, { filePath: path.join(tmp, ".npmrc"), content: "x" }))
    expect(dotfile).toMatchObject({ type: "asked", req: { permission: "edit" } })
    expect(await Filesystem.isFile(path.join(tmp, ".npmrc"))).toBe(false)
  })
})

test("business questions remain available before and after a permission level change", async () => {
  await withAutoTools(async ({ session, tools, resolve }) => {
    expect(tools.question).toBeDefined()

    await selectPermissionLevel({ sessionID: session.id, permissionLevel: "autoApprove" })
    const live = (await Session.get(session.id)).permissionLevel
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
      const parent = await selectPermissionLevel({
        sessionID: (await Session.create({})).id,
        permissionLevel: "autoApprove",
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
        permissionLevel: await Loop.modeOf(child),
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

      await selectPermissionLevel({ sessionID: parent.id, permissionLevel: "fullTakeover" })
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
    await withAutoTools(async ({ tools, session }) => {
      await Config.updateProjectMerakCode({ permission: { bash: "allow" } }, { skipDispose: true })
      Agent.invalidate()
      await selectPermissionLevel({ sessionID: session.id, permissionLevel: "autoApprove" })
      const asked = Promise.withResolvers<void>()
      const unsub = Bus.subscribe(PermissionNext.Event.Asked, () => asked.resolve())
      const running = Promise.resolve(
        executeTool(tools.bash, { command: "git status", description: "Read repository state" }),
      )
      running.catch(() => {})
      await asked.promise
      unsub()
      expect(await PermissionNext.list()).toHaveLength(1)
      await PermissionExecution.install()
      expect(await PermissionNext.list()).toEqual([])
      expect(await running).toMatchObject({ metadata: { exit: 0 } })
    })
  } finally {
    process.env.MERAKCODE_SANDBOX_MODE = previous
    PermissionExecution.useBackendForTest(undefined)
  }
})

test("legacy sandbox off configuration cannot release a pending command", async () => {
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
      await Config.updateProjectMerakCode({ permission: { bash: "allow" } }, { skipDispose: true })
      Agent.invalidate()
      await selectPermissionLevel({ sessionID: session.id, permissionLevel: "autoApprove" })
      PermissionFlush.init()
      const asked = Promise.withResolvers<void>()
      const unsub = Bus.subscribe(PermissionNext.Event.Asked, () => asked.resolve())
      const running = Promise.resolve(
        executeTool(tools.bash, { command: "echo hi > turned-off.txt", description: "write" }),
      )
      running.catch(() => {})
      await asked.promise
      unsub()
      const requestID = (await PermissionNext.list())[0]!.id
      await Config.updateProjectMerakCode({ sandbox: { mode: "off" } }, { skipDispose: true })
      await PermissionFlush.run()
      expect((await PermissionNext.list())[0]?.id).toBe(requestID)
      expect(await Filesystem.isFile(path.join(tmp, "turned-off.txt"))).toBe(false)
      await PermissionNext.reply({ requestID, reply: "reject" })
      await running.catch(() => {})
    })
  } finally {
    if (previous === undefined) delete process.env.MERAKCODE_SANDBOX_MODE
    else process.env.MERAKCODE_SANDBOX_MODE = previous
    PermissionExecution.useBackendForTest(undefined)
  }
})

test("setting up the sandbox preserves a pending file-changing command in ask", async () => {
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
      await selectPermissionLevel({ sessionID: session.id, permissionLevel: "autoApprove" })
      const asked = Promise.withResolvers<void>()
      const unsub = Bus.subscribe(PermissionNext.Event.Asked, () => asked.resolve())
      const running = Promise.resolve(
        executeTool(tools.bash, { command: "echo hi > readonly.txt", description: "write" }),
      )
      running.catch(() => {})
      await asked.promise
      unsub()
      await selectPermissionLevel({ sessionID: session.id, permissionLevel: "ask" })
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
    await withAutoTools(async ({ tools, session }) => {
      await selectPermissionLevel({ sessionID: session.id, permissionLevel: "autoApprove" })
      PermissionFlush.init()
      const asked = Promise.withResolvers<void>()
      const unsub = Bus.subscribe(PermissionNext.Event.Asked, () => asked.resolve())
      const running = Promise.resolve(
        executeTool(tools.bash, { command: "echo hi > denied.txt", description: "write" }),
      )
      running.catch(() => {})
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
      expect(settled).toBe("failed")
      const pending = await PermissionNext.list()
      expect(pending).toHaveLength(0)
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
    await withAutoTools(async ({ tools, session }) => {
      await selectPermissionLevel({ sessionID: session.id, permissionLevel: "autoApprove" })
      const asked = Promise.withResolvers<void>()
      const unsub = Bus.subscribe(PermissionNext.Event.Asked, () => asked.resolve())
      const running = Promise.resolve(executeTool(tools.bash, { command: "git push", description: "publish" }))
      running.catch(() => {})
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

test("switching to auto releases approval even when the sandbox is not ready", async () => {
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
      await selectPermissionLevel({ sessionID: session.id, permissionLevel: "autoApprove" })
      const asked = Promise.withResolvers<void>()
      const unsub = Bus.subscribe(PermissionNext.Event.Asked, () => asked.resolve())
      const running = Promise.resolve(executeTool(tools.bash, { command: "echo hi > stay.txt", description: "write" }))
      running.catch(() => {})
      await asked.promise
      unsub()
      await selectPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover" })
      await running
      expect(await PermissionNext.list()).toEqual([])
    })
  } finally {
    if (previous === undefined) delete process.env.MERAKCODE_SANDBOX_MODE
    else process.env.MERAKCODE_SANDBOX_MODE = previous
    PermissionExecution.useBackendForTest(undefined)
  }
})

test("switching to auto re-evaluates pending approvals and releases the ones now allowed", async () => {
  await withAutoTools(async ({ session, tools }) => {
    await selectPermissionLevel({ sessionID: session.id, permissionLevel: "autoApprove" })
    const asked = Promise.withResolvers<void>()
    const unsub = Bus.subscribe(PermissionNext.Event.Asked, () => asked.resolve())
    const running = executeTool(tools.bash, { command: GRAY_PROBE, description: "probe" })
    await asked.promise
    unsub()
    await selectPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover" })
    await running.catch(() => undefined)
    expect(await PermissionNext.list()).toEqual([])
  })
})

test("a same-mode prompt preserves an active command already approved once", async () => {
  await withAutoTools(async ({ session, tools, tmp }) => {
    await selectPermissionLevel({ sessionID: session.id, permissionLevel: "autoApprove" })
    const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
      void PermissionNext.reply({ requestID: event.properties.id, reply: "once" })
    })
    const controller = new AbortController()
    let finished = false
    const code = "require('node:fs').writeFileSync('same-mode-ready.txt', 'ready'); setInterval(() => {}, 1000)"
    const running = Promise.resolve(
      executeTool(
        tools.bash,
        { command: `node -e ${JSON.stringify(code)}`, description: "Approved running command" },
        controller.signal,
      ),
    ).finally(() => {
      finished = true
    })
    try {
      await expect.poll(() => Filesystem.isFile(path.join(tmp, "same-mode-ready.txt"))).toBe(true)
      await Loop.prompt({
        sessionID: session.id,
        permissionLevel: "autoApprove",
        noReply: true,
        model: { providerID: "openai", modelID: "gpt-4" },
        parts: [{ type: "text", text: "Continue under the same mode" }],
      })
      expect(finished).toBe(false)
    } finally {
      unsubscribe()
      controller.abort()
      await running.catch(() => undefined)
    }
  })
}, 10000)
