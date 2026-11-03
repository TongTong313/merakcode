import { test, expect } from "vitest"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { tmpdir, selectPermissionLevel } from "../fixture/fixture"
import { Session } from "@merakcode/engine/agent/session/index"
import { CronScheduler } from "@merakcode/engine/app/task/cron/index"
import { Storage } from "@merakcode/engine/infra/storage/storage"
import { fakeModel } from "../../../sdk/js/test/fixture/model"

for (const legacy of [false, true])
  test(`scheduled runs use the current root mode after ${legacy ? "legacy recovery" : "leaving auto"}`, async () => {
    const requests: string[] = []
    const model = await fakeModel(async (turn) => {
      requests.push(turn.system)
      return { text: "Scheduled response" }
    })
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
          const session = await Session.create({ title: "Scheduled mode regression" })
          await selectPermissionLevel({ sessionID: session.id, permissionLevel: legacy ? "ask" : "autoApprove" })
          const id = legacy
            ? "legacy-task"
            : await CronScheduler.create({
                sessionID: session.id,
                interval: 50,
                prompt: "Run scheduled probe",
                permissionLevel: "fullTakeover",
              })
          if (legacy) {
            await Storage.write(["cron", session.id, id], {
              id,
              rootID: session.id,
              sessionID: session.id,
              directory: tmp.path,
              interval: 50,
              prompt: "Run scheduled probe",
              permissionMode: "readonly",
              createdAt: Date.now(),
              nextRun: Date.now(),
              status: "running",
            })
            await CronScheduler.recover()
          }
          try {
            await expect.poll(() => requests.length, { timeout: 10000 }).toBeGreaterThan(0)
            expect(requests[0]).toContain(`Current permission level: ${legacy ? "ask" : "autoApprove"}.`)
            expect((await Session.get(session.id)).permissionLevel).toBe(legacy ? "ask" : "autoApprove")
          } finally {
            await CronScheduler.remove(id)
          }
        },
      })
    } finally {
      await Instance.disposeAll()
      await model.close()
    }
  }, 20000)
