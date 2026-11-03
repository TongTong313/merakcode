import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { Instance } from "../../src/infra/project/instance"
import { Session } from "../../src/agent/session"
import { PermissionExecution } from "../../src/agent/permission/execution"
import { PermissionNext } from "../../src/agent/permission/next"
import { PermissionPolicy } from "../../src/agent/permission/policy"
import { WriteTool } from "../../src/agent/tools/write"
import { EditTool } from "../../src/agent/tools/edit"
import { MultiEditTool } from "../../src/agent/tools/multi_edit"
import { Bus } from "../../src/infra/bus"
import type { Tool } from "../../src/agent/tools/tool"
import { readySandbox } from "../fixture/sandbox-ready"
import { tmpdir, selectPermissionLevel } from "../fixture/fixture"

test.each(["write", "edit", "multi_edit"])("%s rechecks isolation before committing a real file", async (kind) => {
  await using tmp = await tmpdir({ git: true, config: { lsp: false } })
  const previous = process.env.MERAKCODE_SANDBOX_MODE
  process.env.MERAKCODE_SANDBOX_MODE = "preferred"
  let lost = false
  PermissionExecution.useBackendForTest({
    status: async () =>
      lost ? { status: "unsupported", reason: "Lost after admission" } : { status: "on", backend: "landlock" },
    wrap: async () => {
      throw new Error("No process expected")
    },
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
          void PermissionNext.reply({ requestID: event.properties.id, reply: "reject" })
        })
        const ctx: Tool.Context = {
          sessionID: session.id,
          messageID: "msg_file",
          callID: "call_file",
          agent: "build",
          permissionLevel: "autoApprove",
          abort: new AbortController().signal,
          messages: [],
          ruleset: PermissionPolicy.ruleset("autoApprove"),
          metadata: () => {},
          ask: async (input) => {
            const receipt = await PermissionNext.askCurrent({ ...input, sessionID: session.id }, async () =>
              PermissionPolicy.ruleset("autoApprove"),
            )
            lost = true
            return receipt
          },
        }
        try {
          const filePath = path.join(tmp.path, "effect.txt")
          const running =
            kind === "write"
              ? (await WriteTool.init()).execute({ filePath, content: "CHANGED" }, ctx)
              : kind === "edit"
                ? (await EditTool.init()).execute({ filePath, oldString: "", newString: "CHANGED" }, ctx)
                : (await MultiEditTool.init()).execute(
                    { filePath, edits: [{ oldString: "", newString: "CHANGED" }] },
                    ctx,
                  )
          await expect(running).rejects.toBeInstanceOf(PermissionNext.RejectedError)
          expect(approvals).toBe(1)
          await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" })
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

test.each(["deny", "manual"] as const)("a real file commit rechecks %s authorization after admission", async (kind) => {
  using _isolation = readySandbox()
  await using tmp = await tmpdir({ git: true, config: { lsp: false } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      let denied = false
      let approvals = 0
      const off = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
        approvals++
        void PermissionNext.reply({
          requestID: event.properties.id,
          decisionRevision: event.properties.decisionRevision,
          reply: "once",
        })
      })
      const ctx: Tool.Context = {
        sessionID: session.id,
        messageID: "msg_conditions",
        callID: "call_conditions",
        agent: "build",
        permissionLevel: "ask",
        abort: new AbortController().signal,
        messages: [],
        ruleset: PermissionPolicy.ruleset("ask"),
        metadata: () => {},
        ask: async (request) => {
          const receipt = await PermissionNext.askCurrent({ ...request, sessionID: session.id }, async () =>
            PermissionPolicy.ruleset((await Session.get(session.id)).permissionLevel ?? "ask", [
              { permission: "edit", pattern: "*", action: denied ? "deny" : "ask" },
            ]),
          )
          if (kind === "deny") denied = true
          else await selectPermissionLevel({ sessionID: session.id, permissionLevel: "autoApprove" })
          return receipt
        },
      }
      const filePath = path.join(tmp.path, "effect.txt")
      try {
        const running = (await WriteTool.init()).execute({ filePath, content: "CHANGED" }, ctx)
        if (kind === "deny") {
          await expect(running).rejects.toBeInstanceOf(PermissionNext.DeniedError)
          await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" })
        } else {
          await running
          expect(await fs.readFile(filePath, "utf8")).toBe("CHANGED")
          expect(approvals).toBe(1)
        }
      } finally {
        off()
      }
    },
  })
})
