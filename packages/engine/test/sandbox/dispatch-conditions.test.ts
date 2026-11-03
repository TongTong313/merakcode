import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { Instance } from "../../src/infra/project/instance"
import { Session } from "../../src/agent/session"
import { PermissionExecution } from "../../src/agent/permission/execution"
import { PermissionNext } from "../../src/agent/permission/next"
import { PermissionPolicy } from "../../src/agent/permission/policy"
import { BashTool } from "../../src/agent/tools/bash"
import { BashBackgroundTool, BashJobStore } from "../../src/agent/tools/bash-background"
import { Bus } from "../../src/infra/bus"
import type { Tool } from "../../src/agent/tools/tool"
import { tmpdir, selectPermissionLevel } from "../fixture/fixture"
import { ModeOperations } from "../../src/agent/permission/operations"

test("a blocked background registration cannot leave a spawned process", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await selectPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover" })
      const release = ModeOperations.block(session.id, "Transition is waiting")
      const ctx: Tool.Context = {
        sessionID: session.id,
        messageID: "msg_blocked",
        callID: "call_blocked",
        agent: "build",
        permissionLevel: "fullTakeover",
        abort: new AbortController().signal,
        messages: [],
        ruleset: [],
        metadata: () => {},
        ask: (input) =>
          PermissionNext.askCurrent({ ...input, sessionID: session.id }, async () =>
            PermissionPolicy.ruleset("fullTakeover"),
          ),
      }
      try {
        await expect(
          (await BashBackgroundTool.init()).execute(
            {
              command: `node -e "require('fs').writeFileSync('effect.txt','CHANGED');setInterval(()=>{},1000)"`,
              description: "Blocked background command",
            },
            ctx,
          ),
        ).rejects.toBeInstanceOf(ModeOperations.PendingError)
        expect(BashJobStore.list().filter((job) => job.sessionID === session.id)).toEqual([])
        await expect(fs.stat(path.join(tmp.path, "effect.txt"))).rejects.toMatchObject({ code: "ENOENT" })
      } finally {
        release()
        await BashJobStore.stopAll()
      }
    },
  })
})

test.each([BashTool, BashBackgroundTool])(
  "$id does not launch after cancellation during metadata persistence",
  async (definition) => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await selectPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover" })
        const controller = new AbortController()
        const ctx: Tool.Context = {
          sessionID: session.id,
          messageID: "msg_cancel",
          callID: "call_cancel",
          agent: "build",
          permissionLevel: "fullTakeover",
          abort: controller.signal,
          messages: [],
          ruleset: PermissionPolicy.ruleset("fullTakeover"),
          metadata: async (input) => {
            if (input.metadata?.executionPath) controller.abort(new Error("Cancelled before launch"))
          },
          ask: (input) =>
            PermissionNext.askCurrent({ ...input, sessionID: session.id }, async () =>
              PermissionPolicy.ruleset("fullTakeover"),
            ),
        }
        try {
          await expect(
            (await definition.init()).execute(
              {
                command: `node -e "require('fs').writeFileSync('effect.txt','CHANGED')"`,
                description: "Cancelled command",
              },
              ctx,
            ),
          ).rejects.toThrow("Cancelled before launch")
          await expect(fs.stat(path.join(tmp.path, "effect.txt"))).rejects.toMatchObject({ code: "ENOENT" })
          expect(BashJobStore.list().filter((job) => job.sessionID === session.id)).toEqual([])
        } finally {
          await BashJobStore.stopAll()
        }
      },
    })
  },
)

test("sandbox loss during metadata persistence requires a fresh decision before launch", async () => {
  await using tmp = await tmpdir({ git: true })
  const previous = process.env.MERAKCODE_SANDBOX_MODE
  process.env.MERAKCODE_SANDBOX_MODE = "preferred"
  let lost = false
  PermissionExecution.useBackendForTest({
    status: async () =>
      lost ? { status: "unsupported", reason: "Lost before launch" } : { status: "on", backend: "landlock" },
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
          metadata: async (input) => {
            if (input.metadata?.executionPath) lost = true
          },
          ask: (input) =>
            PermissionNext.askCurrent({ ...input, sessionID: session.id }, async () =>
              PermissionPolicy.ruleset("autoApprove"),
            ),
        }
        try {
          await expect(
            (await BashTool.init()).execute(
              {
                command: `node -e "require('fs').writeFileSync('effect.txt','CHANGED')"`,
                description: "Revalidate launch conditions",
              },
              ctx,
            ),
          ).rejects.toBeInstanceOf(PermissionNext.RejectedError)
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
