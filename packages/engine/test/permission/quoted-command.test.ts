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

test.each(['--ou"tp"ut', "--outp\\ut"])("autoApprove recognizes shell-normalized output option %s", async (option) => {
  await using tmp = await tmpdir({ git: true })
  const previous = process.env.MERAKCODE_SANDBOX_MODE
  process.env.MERAKCODE_SANDBOX_MODE = "preferred"
  PermissionExecution.useBackendForTest({
    status: async () => ({ status: "on", backend: "landlock" }),
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
        await fs.writeFile(path.join(tmp.path, "sentinel.txt"), "KEEP")
        let approvals = 0
        const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
          approvals++
          void PermissionNext.reply({ requestID: event.properties.id, reply: "reject" })
        })
        const ctx: Tool.Context = {
          sessionID: session.id,
          messageID: "msg_quoted",
          callID: "call_quoted",
          agent: "build",
          permissionLevel: "autoApprove",
          abort: new AbortController().signal,
          messages: [],
          ruleset: PermissionPolicy.ruleset("autoApprove"),
          metadata: () => {},
          ask: (input) =>
            PermissionNext.askCurrent({ ...input, sessionID: session.id }, async () =>
              PermissionPolicy.ruleset("autoApprove"),
            ),
        }
        try {
          const tool = await BashTool.init()
          await expect(
            tool.execute({ command: `git log --oneline ${option}=sentinel.txt`, description: "Inspect history" }, ctx),
          ).rejects.toBeInstanceOf(PermissionNext.RejectedError)
          expect(await fs.readFile(path.join(tmp.path, "sentinel.txt"), "utf8")).toBe("KEEP")
          expect(approvals).toBe(1)
          expect(
            (await tool.execute({ command: "cat sentinel.txt", description: "Read file" }, ctx)).metadata.exit,
          ).toBe(0)
          expect(approvals).toBe(1)
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

test.each(["git diff --no-index --ext-diff before.txt after.txt", "git diff --no-index before.txt after.txt"])(
  "autoApprove asks before an external diff program in %s",
  async (command) => {
    await using tmp = await tmpdir({ git: true })
    const previousMode = process.env.MERAKCODE_SANDBOX_MODE
    const previousDiff = process.env.GIT_EXTERNAL_DIFF
    process.env.MERAKCODE_SANDBOX_MODE = "preferred"
    process.env.GIT_EXTERNAL_DIFF = "node"
    PermissionExecution.useBackendForTest({
      status: async () => ({ status: "on", backend: "landlock" }),
      wrap: async (input) => ({
        file: input.shell,
        args: /cmd(\.exe)?$/i.test(input.shell) ? ["/d", "/s", "/c", input.command] : ["-c", input.command],
        env: input.env,
      }),
    })
    try {
      await fs.writeFile(
        path.join(tmp.path, "before.txt"),
        'require("node:fs").writeFileSync("sentinel.txt", "CHANGED")',
      )
      await fs.writeFile(path.join(tmp.path, "after.txt"), "different")
      await fs.writeFile(path.join(tmp.path, "sentinel.txt"), "KEEP")
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          await selectPermissionLevel({ sessionID: session.id, permissionLevel: "autoApprove" })
          let approvals = 0
          const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
            approvals++
            void PermissionNext.reply({ requestID: event.properties.id, reply: "reject" })
          })
          const ctx: Tool.Context = {
            sessionID: session.id,
            messageID: "msg_diff",
            callID: "call_diff",
            agent: "build",
            permissionLevel: "autoApprove",
            abort: new AbortController().signal,
            messages: [],
            ruleset: PermissionPolicy.ruleset("autoApprove"),
            metadata: () => {},
            ask: (input) =>
              PermissionNext.askCurrent({ ...input, sessionID: session.id }, async () =>
                PermissionPolicy.ruleset("autoApprove"),
              ),
          }
          try {
            const tool = await BashTool.init()
            await expect(tool.execute({ command, description: "Compare files" }, ctx)).rejects.toBeInstanceOf(
              PermissionNext.RejectedError,
            )
            expect(await fs.readFile(path.join(tmp.path, "sentinel.txt"), "utf8")).toBe("KEEP")
            expect(approvals).toBe(1)
            expect(
              (await tool.execute({ command: "cat sentinel.txt", description: "Read file" }, ctx)).metadata.exit,
            ).toBe(0)
            expect(approvals).toBe(1)
          } finally {
            unsubscribe()
          }
        },
      })
    } finally {
      PermissionExecution.useBackendForTest(undefined)
      if (previousMode === undefined) delete process.env.MERAKCODE_SANDBOX_MODE
      else process.env.MERAKCODE_SANDBOX_MODE = previousMode
      if (previousDiff === undefined) delete process.env.GIT_EXTERNAL_DIFF
      else process.env.GIT_EXTERNAL_DIFF = previousDiff
    }
  },
)
