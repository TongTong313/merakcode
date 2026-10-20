import { expect, test } from "vitest"
import { Instance } from "@merakcode/engine/project/instance"
import { Question } from "@merakcode/engine/question/index"
import { Server } from "@merakcode/engine/server/server"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

test("HTTP question routes preserve mandatory pending until a valid explicit answer", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const answer = Question.ask({
        sessionID: "ses_http_required",
        questions: [
          {
            question: "Switch modes?",
            header: "Mode",
            dismiss: false,
            custom: false,
            options: [
              { label: "Yes", description: "Switch" },
              { label: "Skip", description: "Stay" },
            ],
          },
        ],
      })
      const [pending] = await Question.list()
      const url = (action: string) =>
        `http://localhost/question/${pending.id}/${action}?directory=${encodeURIComponent(tmp.path)}`
      const app = Server.App()
      const reject = await app.request(url("reject"), { method: "POST" })
      expect(reject.status).toBe(400)
      const invalid = await app.request(url("reply"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers: [[]] }),
      })
      expect(invalid.status).toBe(400)
      expect((await Question.list()).map((item) => item.id)).toEqual([pending.id])
      const skip = await app.request(url("reply"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers: [["Skip"]] }),
      })
      expect(skip.status).toBe(200)
      expect(await skip.json()).toBe(true)
      expect(await answer).toEqual([["Skip"]])
      const stale = await app.request(url("reject"), { method: "POST" })
      expect(stale.status).toBe(404)
    },
  })
})
