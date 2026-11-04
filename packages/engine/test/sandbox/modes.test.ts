/** Actual isolation status determines per-operation approval in the first two levels. */
import { afterAll, afterEach, beforeAll, expect, test } from "vitest"
import path from "path"
import { BashTool } from "@merakcode/engine/agent/tools/bash"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { PermissionExecution } from "@merakcode/engine/agent/permission/execution"
import { PermissionNext } from "@merakcode/engine/agent/permission/next"
import { PermissionPolicy } from "@merakcode/engine/agent/permission/policy"
import { Bus } from "@merakcode/engine/infra/bus/index"
import type { Tool } from "@merakcode/engine/agent/tools/tool"
import type { Backend } from "@merakcode/engine/infra/sandbox/index"
import { Session } from "@merakcode/engine/agent/session/index"
import { tmpdir, selectPermissionLevel } from "../fixture/fixture"

const previous = process.env.MERAKCODE_SANDBOX_MODE
afterAll(() => {
  process.env.MERAKCODE_SANDBOX_MODE = previous
  PermissionExecution.useBackendForTest(undefined)
})
afterEach(() => PermissionExecution.useBackendForTest(undefined))

const missing: Backend = {
  status: async () => ({ status: "unsupported", installable: true, reason: "needs a one-time setup" }),
  wrap: async () => {
    throw new Error("not set up")
  },
}

const wrapped: string[] = []
const on: Backend = {
  status: async () => ({ status: "on", backend: "landlock" }),
  wrap: async (input) => {
    wrapped.push(input.command)
    return {
      file: input.shell,
      args:
        process.platform === "win32" && /cmd(\.exe)?$/i.test(input.shell)
          ? ["/d", "/s", "/c", input.command]
          : ["-c", input.command],
      env: input.env,
    }
  },
}

beforeAll(() => {
  wrapped.length = 0
})

type AskRequest = Parameters<Tool.Context["ask"]>[0]

/** The real approval center in auto mode; records what was asked and answers "once" */
function approvals(sessionID: string, permissionLevel: "autoApprove" | "fullTakeover") {
  const requests: PermissionNext.Request[] = []
  const ruleset = PermissionPolicy.ruleset(permissionLevel)
  const ask = async (req: AskRequest) => {
    const asked = Promise.withResolvers<PermissionNext.Request>()
    const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
      if (event.properties.sessionID !== sessionID) return
      asked.resolve(event.properties)
      void PermissionNext.reply({ requestID: event.properties.id, reply: "once" })
    })
    const running = PermissionNext.askCurrent({ ...req, sessionID }, async () => ruleset)
    const winner = await Promise.race([
      asked.promise.then((request) => ({ request })),
      running.then(() => undefined),
    ]).finally(unsubscribe)
    if (winner) requests.push(winner.request)
    return await running
  }
  const ctx = {
    sessionID,
    messageID: "",
    callID: "",
    agent: "build",
    permissionLevel,
    abort: AbortSignal.any([]),
    messages: [],
    ruleset,
    metadata: () => {},
    ask,
  }
  return { ctx, requests }
}

async function run(
  mode: string,
  backend: Backend,
  command: string,
  title: string,
  permissionLevel: "autoApprove" | "fullTakeover" = "autoApprove",
) {
  process.env.MERAKCODE_SANDBOX_MODE = mode
  PermissionExecution.useBackendForTest(backend)
  await using tmp = await tmpdir({ git: true })
  // await before returning: the temp folder is removed when this function exits
  return await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ title })
      await selectPermissionLevel({ sessionID: session.id, permissionLevel })
      const { ctx, requests } = approvals(session.id, permissionLevel)
      const bash = await BashTool.init()
      const outcome = await bash.execute({ command, description: "test" }, ctx).then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error }),
      )
      return { ...outcome, requests, dir: tmp.path }
    },
  })
}

test("fullTakeover bypasses approval when isolation is not ready", async () => {
  const { result, error, requests } = await run(
    "preferred",
    missing,
    "echo hi > out.txt",
    "ses_mode_pref_write",
    "fullTakeover",
  )
  expect(requests).toHaveLength(0)
  expect(error).toBeUndefined()
  expect(result?.metadata.exit).toBe(0)
})

test("autoApprove asks for a read-only command when isolation is not ready", async () => {
  const { result, error, requests } = await run("preferred", missing, "pwd", "ses_mode_pref_read")
  expect(requests).toHaveLength(1)
  expect(requests[0].sandboxReady).toBe(false)
  expect(error).toBeUndefined()
  expect(result?.metadata.exit).toBe(0)
})

test("legacy required configuration still asks once when isolation is not ready", async () => {
  const { result, error, requests } = await run("required", missing, "pwd", "ses_mode_required")
  expect(requests).toHaveLength(1)
  expect(requests[0].sandboxReady).toBe(false)
  expect(error).toBeUndefined()
  expect(result?.metadata.exit).toBe(0)
})

test("system isolation prohibition makes autoApprove ask for each command", async () => {
  const { result, error, requests } = await run("off", missing, "echo hi > out.txt", "ses_mode_off")
  expect(requests).toHaveLength(1)
  expect(error).toBeUndefined()
  expect(result?.metadata.exit).toBe(0)
})

test("waking prepares an already set up sandbox so the next command can run inside it", async () => {
  let prepared = false
  const backend: Backend = {
    status: async () => ({ status: "on", backend: "landlock" }),
    warm: async () => {
      prepared = true
    },
    wrap: async (input) => {
      if (!prepared) throw new Error("not prepared")
      return {
        file: input.shell,
        args:
          process.platform === "win32" && /cmd(\.exe)?$/i.test(input.shell)
            ? ["/d", "/s", "/c", input.command]
            : ["-c", input.command],
        env: input.env,
      }
    },
  }
  process.env.MERAKCODE_SANDBOX_MODE = "preferred"
  PermissionExecution.useBackendForTest(backend)
  await PermissionExecution.wake()
  const { result, error, requests } = await run("preferred", backend, "pwd", "ses_wake_prepare")
  expect(requests).toHaveLength(0)
  expect(error).toBeUndefined()
  expect(result?.metadata.exit).toBe(0)
})

test("resetting while sandbox operations are disabled preserves the disabled state", async () => {
  process.env.MERAKCODE_SANDBOX_MODE = "off"
  PermissionExecution.useBackendForTest({
    ...missing,
    reset: async () => ({ status: "unsupported", installable: true, reason: "needs a one-time setup" }),
  })
  const status = await PermissionExecution.reset()
  expect(status).toMatchObject({
    status: "off",
    reason: expect.stringMatching(/System policy|系统策略/),
  })
  expect(status.installable).toBeUndefined()
})

test("disabled sandbox operations do not offer system setup", async () => {
  process.env.MERAKCODE_SANDBOX_MODE = "off"
  PermissionExecution.useBackendForTest(missing)
  const status = await PermissionExecution.current()
  expect(status).toMatchObject({
    status: "off",
    reason: expect.stringMatching(/System policy|系统策略/),
  })
  expect(status.installable).toBeUndefined()
})

test("waking leaves sandbox configuration on while auto bypasses it", async () => {
  process.env.MERAKCODE_SANDBOX_MODE = "preferred"
  PermissionExecution.useBackendForTest(on)
  wrapped.length = 0
  const status = await PermissionExecution.wake()
  expect(status.status).toBe("on")

  const { result, error, requests } = await run("preferred", on, "echo hi > out.txt", "ses_wake_on", "fullTakeover")
  expect(requests).toHaveLength(0)
  expect(wrapped).toEqual([])
  expect(error).toBeUndefined()
  expect(result?.metadata.exit).toBe(0)
})

test("auto bypasses an available sandbox without changing configuration", async () => {
  wrapped.length = 0
  const { result, error, requests, dir } = await run(
    "preferred",
    on,
    "echo hi > out.txt",
    "ses_mode_on",
    "fullTakeover",
  )
  expect(requests).toHaveLength(0)
  expect(wrapped).toEqual([])
  expect(error).toBeUndefined()
  expect(result?.metadata.exit).toBe(0)
  expect(path.isAbsolute(dir)).toBe(true)
})
