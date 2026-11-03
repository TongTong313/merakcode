import { expect, test } from "vitest"
import { Server } from "../../src/app/server/server"
import { Session } from "../../src/agent/session"
import { SessionPlan } from "../../src/agent/session/plan"
import { Instance } from "../../src/infra/project/instance"
import { Loop } from "../../src/agent/loop"
import { Message } from "../../src/agent/session/message"
import { tmpdir, selectPermissionLevel } from "../fixture/fixture"
import { fakeModel } from "../../../sdk/js/test/fixture/model"
import { WorkflowState } from "../../src/app/task/workflow/state"
import { Bus } from "../../src/infra/bus"
import fs from "node:fs/promises"
import path from "node:path"

test.each(["button", "chat"])(
  "a child %s starts the latest shared root plan",
  async (kind) => {
    let seen = ""
    const model = await fakeModel((turn) => {
      seen = JSON.stringify(turn.request)
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
          memory: { auto_extract: false, auto_recall: false, auto_dream: false, session_memory: false },
          lsp: false,
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const root = await Session.create({})
          const child = await Session.create({ parentID: root.id })
          const a = await SessionPlan.save({
            sessionID: root.id,
            source: "human",
            content: "ROOT_A",
            expectedRevision: 0,
          })
          const app = Server.App()
          const url = `/session/${child.id}/plan?directory=${encodeURIComponent(tmp.path)}`
          const read = await app.request(url)
          expect((await read.json()).content).toBe("ROOT_A")
          const save = await app.request(url, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content: "CHILD_APPROVED_B", expectedRevision: a.revision }),
          })
          expect(save.status).toBe(200)
          expect((await save.json()).sessionID).toBe(root.id)
          if (kind === "button") {
            expect(
              (
                await app.request(`/session/${child.id}/plan/start?directory=${encodeURIComponent(tmp.path)}`, {
                  method: "POST",
                })
              ).status,
            ).toBe(200)
            await expect.poll(async () => (await SessionPlan.get(root.id)).status).toBe("completed")
          } else await Loop.prompt({ sessionID: child.id, parts: [{ type: "text", text: "开始执行" }] })
          expect(seen).toContain("CHILD_APPROVED_B")
          expect(seen).not.toContain("ROOT_A")
          expect((await SessionPlan.get(child.id)).execution?.content).toBe("CHILD_APPROVED_B")
          const users = (await Session.messages({ sessionID: root.id })).filter((m) => m.info.role === "user")
          expect(users).toHaveLength(1)
        },
      })
    } finally {
      await Instance.disposeAll()
      await model.close()
    }
  },
  30_000,
)

test("queued button and chat starts share one execution of the latest saved plan", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const executing = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  let executions = 0
  let system = ""
  const model = await fakeModel(async (turn) => {
    if (turn.prompt.includes("BLOCK_FIRST")) {
      entered.resolve()
      await release.promise
      return { text: "FIRST_DONE" }
    }
    executions++
    system = JSON.stringify(turn.request)
    executing.resolve()
    await finish.promise
    return { text: "PLAN_DONE" }
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
        const session = await Session.create({ title: "Plan execution test" })
        const app = Server.App()
        const request = (url: string, body?: unknown) =>
          app.request(`${url}?directory=${encodeURIComponent(tmp.path)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body ?? {}),
          })
        const original = await SessionPlan.save({
          sessionID: session.id,
          content: "PLAN_A",
          expectedRevision: 0,
          source: "human",
        })
        const first = Loop.prompt({
          sessionID: session.id,
          permissionLevel: "ask",
          parts: [{ type: "text", text: "BLOCK_FIRST" }],
        })
        await entered.promise
        const chat = Loop.prompt({
          sessionID: session.id,
          permissionLevel: "ask",
          parts: [{ type: "text", text: "开始执行" }],
        })
        expect((await request(`/session/${session.id}/plan/start`)).status).toBe(200)
        const pending = await SessionPlan.get(session.id)
        expect(pending).toMatchObject({ queued: true })
        expect(pending.execution).toBeUndefined()
        expect((await Session.get(session.id)).permissionLevel).toBe("ask")
        const latest = await SessionPlan.save({
          sessionID: session.id,
          content: "PLAN_B_HUMAN",
          expectedRevision: original.revision,
          source: "human",
        })
        release.resolve()
        await executing.promise
        expect(system).toContain("PLAN_B_HUMAN")
        expect((await SessionPlan.get(session.id)).execution?.content).toBe("PLAN_B_HUMAN")
        await SessionPlan.save({
          sessionID: session.id,
          content: "PLAN_C_LATER",
          expectedRevision: latest.revision,
          source: "human",
        })
        expect((await SessionPlan.get(session.id)).execution?.content).toBe("PLAN_B_HUMAN")
        finish.resolve()
        await Promise.all([first, chat])
        expect(executions).toBe(1)
        const users = []
        for await (const message of Message.stream(session.id)) if (message.info.role === "user") users.push(message)
        expect(users).toHaveLength(2)
      },
    })
  } finally {
    release.resolve()
    finish.resolve()
    await Instance.disposeAll()
    await model.close()
  }
}, 30_000)

test.each(["workflow", "command", "child command"])(
  "background %s keeps the approved plan until all execution work finishes",
  async (kind) => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const continued = Promise.withResolvers<string>()
    let launched = false
    const model = await fakeModel(async (turn) => {
      if (turn.prompt.includes("LAUNCH_CHILD_COMMAND")) {
        if (!turn.results.length)
          return {
            tool: "bash_background",
            args: {
              command: `"${process.execPath.replaceAll("\\", "/")}" background.mjs`,
              description: "Controlled child execution",
            },
          }
        entered.resolve()
        return { text: "CHILD_LAUNCHED" }
      }
      if (turn.prompt.includes("[Background bash job")) {
        continued.resolve(JSON.stringify(turn.request))
        return { text: "BACKGROUND_DONE" }
      }
      if (turn.prompt.includes("CHILD_FROZEN")) {
        if (!turn.results.length) {
          entered.resolve()
          await release.promise
          return { tool: "read", args: { filePath: "input.txt" } }
        }
        continued.resolve(JSON.stringify(turn.request))
        return { text: "CHILD_DONE" }
      }
      if (turn.prompt === "开始执行" && !launched) {
        launched = true
        if (kind === "child command")
          return {
            tool: "subagent",
            args: { subagent_type: "general", prompt: "LAUNCH_CHILD_COMMAND", description: "Background child" },
          }
        if (kind === "command")
          return {
            tool: "bash_background",
            args: {
              command: `"${process.execPath.replaceAll("\\", "/")}" background.mjs`,
              description: "Controlled plan execution",
            },
          }
        return {
          tool: "workflow_run",
          args: {
            script: `export const meta = { name: "frozen", description: "Keep the execution plan" }
return await agent("CHILD_FROZEN", { agent: "general" })`,
          },
        }
      }
      if (kind === "command" && turn.results.some((text) => text.includes("Background job started"))) entered.resolve()
      return { text: "ROOT_DONE" }
    })
    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          agent: { build: { deferTools: [] }, general: { deferTools: [] } },
          model: "alibaba-cn/qwen-plus",
          small_model: "alibaba-cn/qwen-plus",
          enabled_providers: ["alibaba-cn"],
          provider: { "alibaba-cn": { options: { apiKey: "fake", baseURL: model.url } } },
          memory: { auto_extract: false, auto_recall: false, auto_dream: false, session_memory: false },
          lsp: false,
        },
        init: async (dir) => {
          await fs.writeFile(path.join(dir, "input.txt"), "input")
          await fs.writeFile(
            path.join(dir, "background.mjs"),
            `import fs from "node:fs"
while (!fs.existsSync("release-job")) await new Promise(resolve => setTimeout(resolve, 10))
console.log("background-result")`,
          )
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({ title: "Background execution plan" })
          await selectPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover" })
          const completed = Promise.withResolvers<void>()
          const unsubscribe = Bus.subscribe(SessionPlan.Updated, (event) => {
            if (event.properties.sessionID === session.id && event.properties.status === "completed")
              completed.resolve()
          })
          const original = await SessionPlan.save({
            sessionID: session.id,
            content: "FROZEN_PLAN_A",
            expectedRevision: 0,
            source: "human",
          })
          const root = Loop.prompt({
            sessionID: session.id,
            permissionLevel: "fullTakeover",
            parts: [{ type: "text", text: "开始执行" }],
          })
          try {
            await entered.promise
            await root
            expect((await SessionPlan.get(session.id)).status).toBe("executing")
            await Loop.prompt({ sessionID: session.id, parts: [{ type: "text", text: "开始执行" }] })
            expect(
              (await Session.messages({ sessionID: session.id })).filter((message) => message.info.role === "user"),
            ).toHaveLength(1)
            await SessionPlan.save({
              sessionID: session.id,
              content: "LATER_EDITED_PLAN_B",
              expectedRevision: original.revision,
              source: "human",
            })
            release.resolve()
            if (kind !== "workflow") await fs.writeFile(path.join(tmp.path, "release-job"), "release")
            const system = await continued.promise
            expect(system).toContain("FROZEN_PLAN_A")
            expect(system).not.toContain("LATER_EDITED_PLAN_B")
            if (kind === "child command")
              await expect
                .poll(async () => (await SessionPlan.get(session.id)).status, { timeout: 5_000 })
                .toBe("completed")
            await completed.promise
            expect((await SessionPlan.get(session.id)).status).toBe("completed")
            expect((await SessionPlan.get(session.id)).content).toBe("LATER_EDITED_PLAN_B")
          } finally {
            unsubscribe()
            release.resolve()
            await fs.writeFile(path.join(tmp.path, "release-job"), "release")
            await Loop.cancelTree(session.id)
            await root.catch(() => {})
            await expect
              .poll(async () => (await WorkflowState.listRuns(session.id)).every((run) => run.status !== "running"))
              .toBe(true)
          }
        },
      })
    } finally {
      release.resolve()
      await Instance.disposeAll()
      await model.close()
    }
  },
  30_000,
)
