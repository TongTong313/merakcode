import { expect, test } from "vitest"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Session } from "@merakcode/engine/agent/session/index"
import { SessionPlan } from "@merakcode/engine/agent/session/plan"
import { PlanGenerateTool, PlanEditTool } from "@merakcode/engine/agent/tools/plan"
import { PermissionNext } from "@merakcode/engine/agent/permission/next"
import { PermissionPolicy } from "@merakcode/engine/agent/permission/policy"
import { PermissionExecution } from "@merakcode/engine/agent/permission/execution"
import { Bus } from "@merakcode/engine/infra/bus/index"
import type { Tool } from "@merakcode/engine/agent/tools/tool"
import { tmpdir, selectPermissionLevel } from "../fixture/fixture"

const cases = (["ask", "autoApprove", "fullTakeover"] as const).flatMap((permissionLevel) =>
  [true, false].flatMap((ready) =>
    ["once", "reject"].map((reply) => ({ permissionLevel, ready, reply: reply as "once" | "reject" })),
  ),
)

test.each(cases)(
  "official plan approval: $permissionLevel, ready=$ready, reply=$reply",
  async ({ permissionLevel, ready, reply }) => {
    await using tmp = await tmpdir({ git: true })
    const previous = process.env.MERAKCODE_SANDBOX_MODE
    process.env.MERAKCODE_SANDBOX_MODE = "preferred"
    PermissionExecution.useBackendForTest({
      status: async () => (ready ? { status: "on", backend: "landlock" } : { status: "unsupported" }),
      wrap: async () => {
        throw new Error("No command expected")
      },
    })
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          await selectPermissionLevel({ sessionID: session.id, permissionLevel })
          const requests: PermissionNext.Request[] = []
          const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
            requests.push(event.properties)
            void PermissionNext.reply({ requestID: event.properties.id, reply })
          })
          const ctx: Tool.Context = {
            sessionID: session.id,
            messageID: "msg_plan",
            callID: "call_plan",
            agent: "build",
            permissionLevel,
            abort: new AbortController().signal,
            messages: [],
            ruleset: [],
            metadata: () => {},
            ask: (input) =>
              PermissionNext.askCurrent({ ...input, sessionID: session.id }, async () =>
                PermissionPolicy.ruleset(permissionLevel),
              ),
          }
          try {
            const needsApproval = permissionLevel !== "fullTakeover" && (!ready || permissionLevel === "ask")
            const running = (await PlanGenerateTool.init()).execute(
              { content: "Review this plan", expectedRevision: 0 },
              ctx,
            )
            if (needsApproval && reply === "reject") {
              await expect(running).rejects.toBeInstanceOf(PermissionNext.RejectedError)
              expect((await SessionPlan.get(session.id)).content).toBe("")
            } else {
              await running
              expect(await SessionPlan.get(session.id)).toMatchObject({ content: "Review this plan", status: "review" })
              const replacement = "keep literal $& $$ $` $'"
              await (
                await PlanEditTool.init()
              ).execute(
                { oldString: "Review this plan", newString: replacement, expectedRevision: 1 },
                { ...ctx, callID: "call_plan_edit" },
              )
              expect((await SessionPlan.get(session.id)).content).toBe(replacement)
            }
            expect(requests.length).toBe(needsApproval ? (reply === "reject" ? 1 : 2) : 0)
            expect((await Session.get(session.id)).permissionLevel).toBe(permissionLevel)
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
