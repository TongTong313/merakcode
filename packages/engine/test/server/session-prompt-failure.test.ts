import { afterEach, expect, test, vi } from "vitest"
import { Bus } from "@merakcode/engine/bus/index"
import { Instance } from "@merakcode/engine/project/instance"
import { Server } from "@merakcode/engine/server/server"
import { Session } from "@merakcode/engine/session/index"
import { SessionRunner } from "@merakcode/engine/session/runner"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(() => {
  vi.restoreAllMocks()
})

// When the prompt fails before any reply (corrupt message file, model resolution error...), the client needs
// session.error to end the turn, and the message must be a generic one without internal details such as paths.
test("a prompt failing before any reply emits session.error without internal error details", async () => {
  vi.spyOn(SessionRunner, "prompt").mockRejectedValue(new Error("boom at /secret/path"))
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const errors: unknown[] = []
      const unsubscribe = Bus.subscribe(Session.Event.Error, (event) => {
        if (event.properties.sessionID === session.id) errors.push(event.properties.error)
      })
      const response = await Server.App().request(`/session/${session.id}/message`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-merakcode-directory": encodeURIComponent(tmp.path),
        },
        body: JSON.stringify({ parts: [{ type: "text", text: "你好" }] }),
      })
      await response.text()
      unsubscribe()
      expect(response.status).toBe(200)
      expect(errors).toEqual([
        { name: "UnknownError", code: "MRK-9000", data: { message: "会话请求未完成，请重新提交。" } },
      ])
    },
  })
})
