/**
 * sandbox.mode with the bash tool, in auto mode where commands normally run without asking:
 * - preferred: while the sandbox is not ready, commands that change things ask first; read-only ones do not
 * - required: while the sandbox is not ready, commands are refused with MRK-5007
 * - off: commands run as usual
 * The backends here stand in for "not set up" and "on"; real enforcement is tested in packages/sandbox.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "vitest"
import path from "path"
import { BashTool } from "@merakcode/engine/tool/bash"
import { Instance } from "@merakcode/engine/project/instance"
import { Sandbox } from "@merakcode/engine/sandbox/index"
import { PermissionNext } from "@merakcode/engine/permission/next"
import { PermissionPolicy } from "@merakcode/engine/permission/policy"
import { Bus } from "@merakcode/engine/bus/index"
import type { Tool } from "@merakcode/engine/tool/tool"
import type { Backend } from "@merakcode/sandbox"
import { ErrorCode } from "@merakcode/util/error-code"
import { tmpdir } from "../fixture/fixture"

const previous = process.env.MERAKCODE_SANDBOX_MODE
afterAll(() => {
  process.env.MERAKCODE_SANDBOX_MODE = previous
  Sandbox.useBackendForTest(undefined)
})
afterEach(() => Sandbox.useBackendForTest(undefined))

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
function auto(sessionID: string) {
  const requests: PermissionNext.Request[] = []
  const ruleset = PermissionPolicy.ruleset("auto")
  const ask = async (req: AskRequest) => {
    const asked = Promise.withResolvers<PermissionNext.Request>()
    const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
      if (event.properties.sessionID !== sessionID) return
      asked.resolve(event.properties)
      void PermissionNext.reply({ requestID: event.properties.id, reply: "once" })
    })
    const running = PermissionNext.ask({ ...req, sessionID, ruleset })
    const winner = await Promise.race([
      asked.promise.then((request) => ({ request })),
      running.then(() => undefined),
    ]).finally(unsubscribe)
    if (winner) requests.push(winner.request)
    await running
  }
  const ctx = {
    sessionID,
    messageID: "",
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    ruleset,
    metadata: () => {},
    ask,
  }
  return { ctx, requests }
}

async function run(mode: string, backend: Backend, command: string, sessionID: string) {
  process.env.MERAKCODE_SANDBOX_MODE = mode
  Sandbox.useBackendForTest(backend)
  await using tmp = await tmpdir({ git: true })
  // await before returning: the temp folder is removed when this function exits
  return await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const { ctx, requests } = auto(sessionID)
      const bash = await BashTool.init()
      const outcome = await bash.execute({ command, description: "test" }, ctx).then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error }),
      )
      return { ...outcome, requests, dir: tmp.path }
    },
  })
}

test("preferred, sandbox not ready: a command that changes things asks first, even in auto mode", async () => {
  const { result, error, requests } = await run("preferred", missing, "echo hi > out.txt", "ses_mode_pref_write")
  expect(requests).toHaveLength(1)
  expect(requests[0]!.metadata.tags).toContain("no-sandbox")
  expect(error).toBeUndefined()
  expect(result?.metadata.exit).toBe(0)
})

test("preferred, sandbox not ready: a read-only command does not ask", async () => {
  const { requests } = await run("preferred", missing, "git status", "ses_mode_pref_read")
  expect(requests).toHaveLength(0)
})

test("required, sandbox not ready: commands are refused with MRK-5007, pointing to the desktop settings first", async () => {
  const { error, requests } = await run("required", missing, "git status", "ses_mode_required")
  expect(requests).toHaveLength(0)
  expect(Sandbox.SetupRequiredError.isInstance(error)).toBe(true)
  const refused = error as InstanceType<typeof Sandbox.SetupRequiredError>
  expect(refused.toObject().code).toBe("MRK-5007")
  expect(refused.data.message).toContain("Settings → Permissions & security")
  expect(refused.data.message).toContain("merak sandbox setup")
  const hint = ErrorCode.CATALOG.SANDBOX_SETUP_REQUIRED.hint
  expect(hint.zh).toContain("设置 → 权限与安全")
  expect(hint.en).toContain("Settings → Permissions & security")
  for (const text of [hint.zh, hint.en]) expect(text).toContain("merak sandbox setup")
})

test("off: commands run as usual without asking", async () => {
  const { result, error, requests } = await run("off", missing, "echo hi > out.txt", "ses_mode_off")
  expect(requests).toHaveLength(0)
  expect(error).toBeUndefined()
  expect(result?.metadata.exit).toBe(0)
})

test("preferred, sandbox on: commands go through the sandbox without an extra question", async () => {
  wrapped.length = 0
  const { result, error, requests, dir } = await run("preferred", on, "echo hi > out.txt", "ses_mode_on")
  expect(requests).toHaveLength(0)
  expect(wrapped).toEqual(["echo hi > out.txt"])
  expect(error).toBeUndefined()
  expect(result?.metadata.exit).toBe(0)
  expect(path.isAbsolute(dir)).toBe(true)
})
