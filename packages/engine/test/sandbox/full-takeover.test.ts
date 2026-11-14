import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Session } from "@merakcode/engine/agent/session/index"
import { PermissionNext } from "@merakcode/engine/agent/permission/next"
import { PermissionPolicy } from "@merakcode/engine/agent/permission/policy"
import { PermissionExecution } from "@merakcode/engine/agent/permission/execution"
import { BashTool } from "@merakcode/engine/agent/tools/bash"
import { Bus } from "@merakcode/engine/infra/bus/index"
import type { Tool } from "@merakcode/engine/agent/tools/tool"
import { tmpdir, selectPermissionLevel } from "../fixture/fixture"

test("sandbox loss after approval requires a new decision before a host process starts", async () => {
  await using tmp = await tmpdir({ git: true })
  const previous = process.env.MERAKCODE_SANDBOX_MODE
  process.env.MERAKCODE_SANDBOX_MODE = "preferred"
  PermissionExecution.useBackendForTest({
    status: async () =>
      (await fs.stat(path.join(tmp.path, "sandbox-lost")).then(
        () => true,
        () => false,
      ))
        ? { status: "unsupported", reason: "lost after approval" }
        : { status: "on", backend: "landlock" },
    wrap: async (input) => ({
      file: input.shell,
      args: /cmd(\.exe)?$/i.test(input.shell) ? ["/d", "/s", "/c", input.command] : ["-c", input.command],
      env: input.env,
    }),
  })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await selectPermissionLevel({ sessionID: session.id, permissionLevel: "autoApprove" })
        let approvals = 0
        const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
          approvals++
          void PermissionNext.reply({ requestID: event.properties.id, reply: approvals === 1 ? "once" : "reject" })
        })
        const ctx: Tool.Context = {
          sessionID: session.id,
          messageID: "msg_loss",
          callID: "call_loss",
          agent: "build",
          permissionLevel: "autoApprove",
          abort: new AbortController().signal,
          messages: [],
          ruleset: PermissionPolicy.ruleset("autoApprove"),
          metadata: async () => {
            await fs.writeFile(path.join(tmp.path, "sandbox-lost"), "lost")
          },
          ask: (input) =>
            PermissionNext.askCurrent({ ...input, sessionID: session.id }, async () =>
              PermissionPolicy.ruleset("autoApprove"),
            ),
        }
        try {
          const result = (await BashTool.init()).execute(
            {
              command: "git push origin main",
              description: "Check execution conditions",
            },
            ctx,
          )
          await expect(result).rejects.toBeInstanceOf(PermissionNext.RejectedError)
          expect(approvals).toBe(2)
          await expect(fs.stat(path.join(tmp.path, "effect.txt"))).rejects.toMatchObject({ code: "ENOENT" })
        } finally {
          unsubscribe()
        }
      },
    })
  } finally {
    PermissionExecution.useBackendForTest(undefined)
    if (previous === undefined) delete process.env.MERAKCODE_SANDBOX_MODE
    else process.env.MERAKCODE_SANDBOX_MODE = previous
  }
})

test("concurrent sandbox setup requests share one initialization", async () => {
  await using tmp = await tmpdir({ git: true })
  const previous = process.env.MERAKCODE_SANDBOX_MODE
  process.env.MERAKCODE_SANDBOX_MODE = "preferred"
  const release = Promise.withResolvers<void>()
  let calls = 0
  PermissionExecution.useBackendForTest({
    status: async () => ({ status: "unsupported", installable: true }),
    setup: async () => {
      calls++
      await release.promise
      return { status: "on", backend: "landlock" }
    },
    wrap: async () => {
      throw new Error("No command expected")
    },
  })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const pending = [PermissionExecution.install(), PermissionExecution.install()]
        try {
          await expect.poll(() => calls).toBeGreaterThan(0)
          expect(calls).toBe(1)
        } finally {
          release.resolve()
          await Promise.all(pending)
        }
      },
    })
  } finally {
    release.resolve()
    PermissionExecution.useBackendForTest(undefined)
    if (previous === undefined) delete process.env.MERAKCODE_SANDBOX_MODE
    else process.env.MERAKCODE_SANDBOX_MODE = previous
  }
})

test.each(["ask", "autoApprove"] as const)(
  "legacy required configuration still asks per operation in %s",
  async (permissionLevel) => {
    await using tmp = await tmpdir({ git: true })
    const previous = process.env.MERAKCODE_SANDBOX_MODE
    process.env.MERAKCODE_SANDBOX_MODE = "required"
    PermissionExecution.useBackendForTest({
      status: async () => ({ status: "unsupported", reason: "Unavailable" }),
      wrap: async () => {
        throw new Error("Must not launch")
      },
    })
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          await selectPermissionLevel({ sessionID: session.id, permissionLevel })
          let approvals = 0
          const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
            approvals++
            void PermissionNext.reply({ requestID: event.properties.id, reply: "reject" })
          })
          const ctx: Tool.Context = {
            sessionID: session.id,
            messageID: "msg_missing",
            callID: "call_missing",
            agent: "build",
            permissionLevel,
            abort: new AbortController().signal,
            messages: [],
            ruleset: PermissionPolicy.ruleset(permissionLevel),
            metadata: () => {},
            ask: (input) =>
              PermissionNext.askCurrent({ ...input, sessionID: session.id }, async () =>
                PermissionPolicy.ruleset(permissionLevel),
              ),
          }
          try {
            await expect(
              (await BashTool.init()).execute(
                { command: "echo value > blocked.txt", description: "Unisolated operation" },
                ctx,
              ),
            ).rejects.toBeInstanceOf(PermissionNext.RejectedError)
            expect(approvals).toBe(1)
            await expect(fs.stat(path.join(tmp.path, "blocked.txt"))).rejects.toMatchObject({ code: "ENOENT" })
          } finally {
            unsubscribe()
          }
        },
      })
    } finally {
      PermissionExecution.useBackendForTest(undefined)
      if (previous === undefined) delete process.env.MERAKCODE_SANDBOX_MODE
      else process.env.MERAKCODE_SANDBOX_MODE = previous
    }
  },
)

test("fullTakeover chooses isolation before launch and never replays an arbitrary script", async () => {
  await using tmp = await tmpdir({ git: true })
  const previous = process.env.MERAKCODE_SANDBOX_MODE
  process.env.MERAKCODE_SANDBOX_MODE = "preferred"
  const isolated: string[] = []
  PermissionExecution.useBackendForTest({
    status: async () => ({ status: "on", backend: "landlock" }),
    wrap: async (input) => {
      isolated.push(input.command)
      return {
        file: input.shell,
        args: /cmd(\.exe)?$/i.test(input.shell) ? ["/d", "/s", "/c", input.command] : ["-c", input.command],
        env: input.env,
      }
    },
  })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await selectPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover" })
        let approvals = 0
        const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, () => {
          approvals++
        })
        const ctx: Tool.Context = {
          sessionID: session.id,
          messageID: "msg_route",
          callID: "call_route",
          agent: "build",
          permissionLevel: "fullTakeover",
          abort: new AbortController().signal,
          messages: [],
          ruleset: PermissionPolicy.ruleset("fullTakeover"),
          metadata: () => {},
          ask: (input) =>
            PermissionNext.askCurrent({ ...input, sessionID: session.id }, async () =>
              PermissionPolicy.ruleset("fullTakeover"),
            ),
        }
        try {
          const tool = await BashTool.init()
          expect(
            (await tool.execute({ command: "pwd", description: "Inspect the project directory" }, ctx)).metadata.exit,
          ).toBe(0)
          expect(
            (
              await tool.execute(
                { command: `node -e "require('fs').appendFileSync('effect.txt','x')"`, description: "Run one script" },
                ctx,
              )
            ).metadata.exit,
          ).toBe(0)
          expect(
            (
              await tool.execute(
                { command: "git ls-remote .", description: "Read a remote using the current account" },
                ctx,
              )
            ).metadata.exit,
          ).toBe(0)
          expect(
            (await tool.execute({ command: "whoami", description: "Read the current account identity" }, ctx)).metadata
              .exit,
          ).toBe(0)
          expect(isolated).toEqual(["pwd"])
          expect(approvals).toBe(0)
          expect(await fs.readFile(path.join(tmp.path, "effect.txt"), "utf8")).toBe("x")
        } finally {
          unsubscribe()
        }
      },
    })
  } finally {
    PermissionExecution.useBackendForTest(undefined)
    if (previous === undefined) delete process.env.MERAKCODE_SANDBOX_MODE
    else process.env.MERAKCODE_SANDBOX_MODE = previous
  }
})
