import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { Server } from "../../src/app/server/server"
import { Session } from "../../src/agent/session"
import { SessionPlan } from "../../src/agent/session/plan"
import { BashJobStore } from "../../src/agent/tools/bash-background"
import { Instance } from "../../src/infra/project/instance"
import { Bus } from "../../src/infra/bus"
import { tmpdir, selectPermissionLevel } from "../fixture/fixture"
import { fakeModel } from "../../../sdk/js/test/fixture/model"

test.each(["failed", "stopped"] as const)(
  "a %s background command releases the plan button",
  async (outcome) => {
    let launched = false
    let notified = false
    const model = await fakeModel((turn) => {
      if (turn.prompt.includes("[Background bash job")) notified = true
      if (!launched) {
        launched = true
        return {
          tool: "bash_background",
          args: {
            command: `"${process.execPath.replaceAll("\\", "/")}" background.mjs`,
            description: "Controlled unsuccessful plan command",
          },
        }
      }
      return { text: "DONE" }
    })
    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          model: "alibaba-cn/qwen-plus",
          small_model: "alibaba-cn/qwen-plus",
          enabled_providers: ["alibaba-cn"],
          provider: { "alibaba-cn": { options: { apiKey: "fake", baseURL: model.url } } },
          agent: { build: { deferTools: [] } },
          memory: { auto_extract: false, auto_recall: false, auto_dream: false, session_memory: false },
          lsp: false,
        },
        init: async (directory) => {
          await fs.writeFile(
            path.join(directory, "background.mjs"),
            `import fs from "node:fs"
fs.writeFileSync("ready", "ready")
while (!fs.existsSync("release")) await new Promise(resolve => setTimeout(resolve, 10))
process.exit(2)`,
          )
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({ title: "Background failure fixture" })
          await selectPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover" })
          await SessionPlan.save({
            sessionID: session.id,
            content: "Execute the controlled background command.",
            source: "human",
            expectedRevision: 0,
          })
          try {
            const response = await Server.App().request(
              `/session/${session.id}/plan/start?directory=${encodeURIComponent(tmp.path)}`,
              { method: "POST" },
            )
            expect(response.status).toBe(200)
            await expect
              .poll(() => fs.readFile(path.join(tmp.path, "ready"), "utf8").catch(() => ""), { timeout: 10000 })
              .toBe("ready")
            await expect
              .poll(async () =>
                (await Session.messages({ sessionID: session.id })).some(
                  (message) =>
                    message.info.role === "assistant" &&
                    message.parts.some((part) => part.type === "text" && part.text === "DONE"),
                ),
              )
              .toBe(true)
            expect((await SessionPlan.get(session.id)).status).toBe("executing")
            const job = BashJobStore.list().find((job) => job.sessionID === session.id)!
            if (outcome === "stopped") await BashJobStore.stop(job.id)
            else await fs.writeFile(path.join(tmp.path, "release"), "release")
            await expect.poll(() => notified, { timeout: 10000 }).toBe(true)
            await expect.poll(async () => (await SessionPlan.get(session.id)).status).toBe(outcome)
            expect((await SessionPlan.get(session.id)).buttonLocked).toBe(false)
            const previousID = (await SessionPlan.get(session.id)).execution?.id
            const settled = Promise.withResolvers<void>()
            const unsubscribe = Bus.subscribe(SessionPlan.Updated, ({ properties }) => {
              if (
                properties.sessionID !== session.id ||
                !properties.execution ||
                properties.execution.id === previousID ||
                !["completed", "failed", "stopped"].includes(properties.status)
              )
                return
              settled.resolve()
            })
            try {
              expect(
                (
                  await Server.App().request(
                    `/session/${session.id}/plan/start?directory=${encodeURIComponent(tmp.path)}`,
                    { method: "POST" },
                  )
                ).status,
              ).toBe(200)
              await settled.promise
              const result = await SessionPlan.get(session.id)
              expect(result.status).toBe("completed")
              expect(result.execution?.id).not.toBe(previousID)
            } finally {
              unsubscribe()
            }
          } finally {
            await BashJobStore.stopAll()
          }
        },
      })
    } finally {
      await Instance.disposeAll()
      await model.close()
    }
  },
  30000,
)
