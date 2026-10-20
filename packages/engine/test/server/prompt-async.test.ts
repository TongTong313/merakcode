import { expect, test } from "vitest"
import { Instance } from "@merakcode/engine/project/instance"
import { Server } from "@merakcode/engine/server/server"
import { Session } from "@merakcode/engine/session/index"
import { tmpdir } from "../fixture/fixture"

// The desktop app sends messages through prompt_async, which answers 204 right away and streams the reply as events.
// Node's Response rejects a body on 204, which would turn into a 500.
test("prompt_async returns 204 immediately without a body", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ title: "async" })
      const response = await Server.App().request(
        `http://localhost/session/${session.id}/prompt_async?directory=${encodeURIComponent(tmp.path)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parts: [{ type: "text", text: "hello" }] }),
        },
      )
      expect(response.status).toBe(204)
      expect(await response.text()).toBe("")
    },
  })
})
