import { PermissionNext } from "../../src/agent/permission/next"
import { Bus } from "../../src/infra/bus"
import { expect, test } from "vitest"
import path from "node:path"
import { fakeModel } from "../../../sdk/js/test/fixture/model"
import { tmpdir, selectPermissionLevel } from "../fixture/fixture"
import { Instance } from "../../src/infra/project/instance"
import { Session } from "../../src/agent/session"
import { Loop } from "../../src/agent/loop"
import { WorkflowRuntime } from "../../src/app/task/workflow/runtime"
import { SessionNotification } from "../../src/agent/session/notification"
import { SessionNotificationDelivery } from "../../src/agent/loop/notification-delivery"
import { Filesystem } from "@merakcode/util/filesystem"

test.each(["child", "notification", "cancelled-child"] as const)(
  "workflow %s keeps its original draft scope",
  async (kind) => {
    const model = await fakeModel((turn) =>
      ["只出稿，不要修改项目。", "开始实施另一个任务。"].includes(turn.prompt)
        ? { text: "Human request settled" }
        : turn.results.length === 0
          ? { tool: "write", args: { filePath: "effect.txt", content: "CHANGED" } }
          : { text: "Original workflow complete" },
    )
    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          model: "alibaba-cn/qwen-plus",
          small_model: "alibaba-cn/qwen-plus",
          enabled_providers: ["alibaba-cn"],
          provider: { "alibaba-cn": { options: { apiKey: "fake", baseURL: model.url } } },
          memory: { auto_extract: false, auto_recall: false, auto_dream: false, session_memory: false },
          lsp: false,
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          await selectPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover" })
          const origin = await Loop.prompt({
            sessionID: session.id,
            parts: [{ type: "text", text: "只出稿，不要修改项目。" }],
          })
          await Loop.prompt({ sessionID: session.id, parts: [{ type: "text", text: "开始实施另一个任务。" }] })
          let childID: string | undefined
          if (kind !== "notification") {
            const controller = new AbortController()
            const body = "return await agent('Review the design', { agent: 'build' })"
            await WorkflowRuntime.run({
              sessionID: session.id,
              messageID: origin.info.id,
              args: {},
              abort: controller.signal,
              defaultModel: { providerID: "alibaba-cn", modelID: "qwen-plus" },
              script: {
                name: "draft",
                description: "Controlled draft",
                phases: [],
                source: "custom",
                body,
                script: `export const meta = { name: 'draft' }\n${body}`,
              },
              hooks: {
                update: async (metadata) => {
                  childID = metadata.agents.find((agent) => agent.sessionId)?.sessionId
                  if (kind === "cancelled-child" && childID) controller.abort()
                },
              },
            }).catch((error) => {
              if (kind !== "cancelled-child") throw error
              expect(error).toMatchObject({ name: "AbortError" })
            })
          } else {
            await SessionNotification.enqueue({
              sessionID: session.id,
              type: "workflow.finished",
              text: "Original workflow finished",
              agent: "build",
              model: { providerID: "alibaba-cn", modelID: "qwen-plus" },
              metadata: { taskOriginMessageID: origin.info.id },
            })
            SessionNotificationDelivery.request(session.id, { delay: 0 })
            childID = session.id
          }
          if (kind === "cancelled-child") {
            expect(model.turns).toHaveLength(2)
            return
          }
          await expect
            .poll(
              async () =>
                !!childID &&
                (await Session.messages({ sessionID: childID }))
                  .flatMap((m) => m.parts)
                  .some((p) => p.type === "text" && p.text === "Original workflow complete"),
              { timeout: 15000 },
            )
            .toBe(true)
          const attempts = (await Session.messages({ sessionID: childID! }))
            .flatMap((m) => m.parts)
            .filter((p) => p.type === "tool" && p.tool === "write")
          expect(attempts).toHaveLength(1)
          expect(attempts[0]).toMatchObject({ state: { status: "error", error: expect.stringMatching(/MRK-5014/) } })
          expect(await Filesystem.exists(path.join(tmp.path, "effect.txt"))).toBe(false)
        },
      })
    } finally {
      await Instance.disposeAll()
      await model.close()
    }
  },
  25000,
)

test.each(["ask", "autoApprove"] as const)(
  "workflow agent calls require actual %s delegation consent",
  async (permissionLevel) => {
    const model = await fakeModel(() => ({ text: "Child ran without consent" }))
    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          model: "alibaba-cn/qwen-plus",
          small_model: "alibaba-cn/qwen-plus",
          enabled_providers: ["alibaba-cn"],
          provider: { "alibaba-cn": { options: { apiKey: "fake", baseURL: model.url } } },
          memory: { auto_extract: false, auto_recall: false, auto_dream: false, session_memory: false },
          lsp: false,
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          await selectPermissionLevel({ sessionID: session.id, permissionLevel })
          const source = await Loop.prompt({
            sessionID: session.id,
            noReply: true,
            parts: [{ type: "text", text: "Run a controlled workflow" }],
          })
          const shown: PermissionNext.Request[] = []
          const off = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
            shown.push(event.properties)
            void PermissionNext.reply({ requestID: event.properties.id, reply: "reject" })
          })
          const body = "return await agent('Controlled child', { agent: 'build' })"
          try {
            await expect(
              WorkflowRuntime.run({
                sessionID: session.id,
                messageID: source.info.id,
                args: {},
                abort: new AbortController().signal,
                defaultModel: { providerID: "alibaba-cn", modelID: "qwen-plus" },
                script: {
                  name: "consent",
                  description: "Controlled workflow",
                  phases: [],
                  source: "custom",
                  body,
                  script: `export const meta = { name: 'consent' }\n${body}`,
                },
                hooks: { update: async () => {} },
              }),
            ).rejects.toBeInstanceOf(PermissionNext.RejectedError)
            expect(shown).toHaveLength(1)
            expect(shown[0].permission).toBe("subagent")
            expect(model.turns).toHaveLength(0)
            expect(await Session.children(session.id)).toHaveLength(0)
          } finally {
            off()
          }
        },
      })
    } finally {
      await Instance.disposeAll()
      await model.close()
    }
  },
  20000,
)
