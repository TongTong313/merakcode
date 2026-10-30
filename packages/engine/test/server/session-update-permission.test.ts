import { describe, expect, test } from "vitest"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Server } from "@merakcode/engine/app/server/server"
import { Session } from "@merakcode/engine/agent/session/index"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

/**
 * session.update does not change permission rules: approvals go through `permission.reply` (once / reject) and
 * lasting trust through sandbox approval. Silently stripping `permission` and returning 200 would make callers think
 * "always allow" took effect, so the route returns 400 and applies none of the request, not even its other fields.
 */

function patch(app: ReturnType<typeof Server.App>, sessionID: string, body: unknown) {
  return app.request(`/session/${sessionID}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-merakcode-directory": encodeURIComponent(Instance.directory),
    },
    body: JSON.stringify(body),
  })
}

describe("PATCH /session/:sessionID permission field", () => {
  test("returns 400 with permission and does not apply the title from the same request", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({ title: "原标题" })
        const response = await patch(app, session.id, {
          title: "新标题",
          permission: [{ permission: "read", pattern: "*", action: "allow" }],
        })
        expect(response.status).toBe(400)
        const body = (await response.json()) as {
          code: string
          message: string
          data: { issues: Array<{ path: string[]; message: string }> }
        }
        expect(body.code).toBe("MRK-1009")
        expect(body.message).toContain("permission: ")
        expect(body.data.issues[0]?.path).toEqual(["permission"])
        expect(body.data.issues[0]?.message).toContain("不支持")
        expect((await Session.get(session.id)).title).toBe("原标题")
      },
    })
  })

  test("updates without permission still apply", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({ title: "原标题" })
        const response = await patch(app, session.id, { title: "新标题", time: { archived: 1 } })
        expect(response.status).toBe(200)
        const updated = (await response.json()) as Session.Info
        expect(updated.title).toBe("新标题")
        expect(updated.time.archived).toBe(1)
      },
    })
  })
})
