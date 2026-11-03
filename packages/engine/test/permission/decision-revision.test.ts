import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { PermissionNext } from "../../src/agent/permission/next"
import { PermissionExecution } from "../../src/agent/permission/execution"
import { PermissionPolicy } from "../../src/agent/permission/policy"
import { WriteTool } from "../../src/agent/tools/write"
import type { Tool } from "../../src/agent/tools/tool"
import { Instance } from "../../src/infra/project/instance"
import { Identifier } from "@merakcode/util/id"
import { Session } from "../../src/agent/session"
import { tmpdir } from "../fixture/fixture"

test("an approval for the old isolation conditions cannot approve the refreshed request", async () => {
  await using tmp = await tmpdir({ git: true, config: { lsp: false } })
  const previous = process.env.MERAKCODE_SANDBOX_MODE
  process.env.MERAKCODE_SANDBOX_MODE = "preferred"
  let lost = false
  PermissionExecution.useBackendForTest({
    status: async () =>
      lost ? { status: "unsupported", reason: "Isolation lost" } : { status: "on", backend: "landlock" },
    wrap: async () => {
      throw new Error("No process expected")
    },
  })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const userID = Identifier.ascending("message")
        await Session.updateInfo({
          id: userID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-4" },
        })
        const messageID = Identifier.ascending("message")
        await Session.updateInfo({
          id: messageID,
          sessionID: session.id,
          role: "assistant",
          parentID: userID,
          time: { created: Date.now() },
          agent: "build",
          mode: "build",
          path: { cwd: tmp.path, root: tmp.path },
          modelID: "gpt-4",
          providerID: "openai",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
        const controller = new AbortController()
        const ctx: Tool.Context = {
          sessionID: session.id,
          messageID,
          callID: "call_decision",
          agent: "build",
          permissionLevel: "ask",
          abort: controller.signal,
          messages: [],
          ruleset: PermissionPolicy.ruleset("ask"),
          metadata: () => {},
          ask: (request) =>
            PermissionNext.askCurrent(
              { ...request, sessionID: session.id, tool: { messageID, callID: "call_decision" } },
              async () => PermissionPolicy.ruleset("ask"),
              controller.signal,
            ),
        }
        const writing = (await WriteTool.init()).execute(
          { filePath: path.join(tmp.path, "effect.txt"), content: "CHANGED" },
          ctx,
        )
        writing.catch(() => {})
        try {
          await expect.poll(async () => (await PermissionNext.list()).length).toBe(1)
          const original = structuredClone((await PermissionNext.list())[0]!)
          lost = true
          await expect(
            PermissionNext.reply({
              requestID: original.id,
              reply: "once",
              decisionRevision: 0,
            } as PermissionNext.ReplyInput),
          ).rejects.toMatchObject({
            name: "PermissionDecisionConflictError",
            data: { message: expect.stringMatching(/conditions|条件/) },
          })
          expect((await PermissionNext.list())[0]?.id).toBe(original.id)
          await expect(fs.stat(path.join(tmp.path, "effect.txt"))).rejects.toMatchObject({ code: "ENOENT" })
        } finally {
          controller.abort()
          for (const request of await PermissionNext.list())
            await PermissionNext.reply({ requestID: request.id, reply: "reject" })
          await writing.catch(() => {})
        }
      },
    })
  } finally {
    PermissionExecution.useBackendForTest(undefined)
    if (previous === undefined) delete process.env.MERAKCODE_SANDBOX_MODE
    else process.env.MERAKCODE_SANDBOX_MODE = previous
  }
})
