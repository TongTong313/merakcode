import { expect, test } from "vitest"
import { decideExternal } from "../../src/agent/external/runtime"
import { PermissionNext } from "../../src/agent/permission/next"
import { Bus } from "../../src/infra/bus"
import { Instance } from "../../src/infra/project/instance"
import { Session } from "../../src/agent/session"
import { tmpdir, selectPermissionLevel } from "../fixture/fixture"
import { readySandbox } from "../fixture/sandbox-ready"

test.each(["ask", "autoApprove"] as const)(
  "an unisolated external tool named plan_generate cannot reuse consent in %s",
  async (permissionLevel) => {
    using _isolation = readySandbox()
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await selectPermissionLevel({ sessionID: session.id, permissionLevel })
        const shown: PermissionNext.Request[] = []
        const replies: Promise<void>[] = []
        const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
          shown.push(event.properties)
          replies.push(
            PermissionNext.reply({
              requestID: event.properties.id,
              reply: event.properties.grants?.length ? "session" : "once",
            }),
          )
        })
        try {
          const context = { sessionID: session.id, executionID: "unisolated-adapter", cwd: tmp.path }
          const request = { kind: "tool" as const, name: "plan_generate", detail: "External native tool" }
          expect(await decideExternal(context, request)).toEqual({ allow: true })
          expect(await decideExternal(context, request)).toEqual({ allow: true })
          await Promise.all(replies)
          expect(shown).toHaveLength(2)
          expect(shown.map((item) => item.sandboxReady)).toEqual([false, false])
          expect(shown.map((item) => item.grants)).toEqual([[], []])
          expect(await PermissionNext.grants(session.id)).toEqual([])
        } finally {
          unsubscribe()
          await PermissionNext.abortPending(session.id)
        }
      },
    })
  },
)
