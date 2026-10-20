import { afterEach, describe, expect, test } from "vitest"
import { Instance } from "@merakcode/engine/project/instance"
import { Server } from "@merakcode/engine/server/server"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll().catch(() => undefined)
})

const DAY = 24 * 60 * 60 * 1000

/** One turn: a user message and an assistant reply with one bash call, usage and cost */
function exported(input: { title: string; updated: number; model: string; cost: number; input: number }) {
  const sessionID = "ses_00000000000000000000000000"
  const user = "msg_user0000000000000000000"
  const assistant = "msg_asst0000000000000000000"
  const [providerID, modelID] = input.model.split("/")
  return {
    info: {
      id: sessionID,
      slug: "stats",
      projectID: "elsewhere",
      directory: "/elsewhere",
      title: input.title,
      version: "0.1.0",
      time: { created: input.updated, updated: input.updated },
    },
    messages: [
      {
        info: {
          id: user,
          sessionID,
          role: "user",
          time: { created: input.updated },
          agent: "build",
          model: { providerID, modelID },
        },
        parts: [{ id: "prt_user000000000000000000", sessionID, messageID: user, type: "text", text: "跑一下测试" }],
      },
      {
        info: {
          id: assistant,
          sessionID,
          role: "assistant",
          time: { created: input.updated },
          parentID: user,
          providerID,
          modelID,
          mode: "build",
          agent: "build",
          path: { cwd: "/elsewhere", root: "/elsewhere" },
          cost: input.cost,
          tokens: { input: input.input, output: 10, reasoning: 5, cache: { read: 2, write: 1 } },
        },
        parts: [
          {
            id: "prt_asst000000000000000000",
            sessionID,
            messageID: assistant,
            type: "tool",
            callID: "call_1",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "pnpm test" },
              output: "ok",
              title: "pnpm test",
              metadata: {},
              time: { start: input.updated, end: input.updated },
            },
          },
        ],
      },
    ],
  }
}

async function importInto(app: ReturnType<typeof Server.App>, directory: string, body: ReturnType<typeof exported>) {
  const response = await app.request(`/session/import-full?directory=${encodeURIComponent(directory)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(200)
  return ((await response.json()) as { info: { projectID: string } }).info
}

describe("global.stats", () => {
  test("aggregates usage stats across projects and filters them by project and recent days", async () => {
    await using first = await tmpdir({ git: true })
    await using second = await tmpdir({ git: true })
    const app = Server.App()
    const now = Date.now()
    const recent = await importInto(
      app,
      first.path,
      exported({ title: "近期", updated: now, model: "alibaba-cn/qwen-plus", cost: 0.5, input: 100 }),
    )
    await importInto(
      app,
      second.path,
      exported({ title: "很久以前", updated: now - 30 * DAY, model: "deepseek/deepseek-chat", cost: 0.25, input: 40 }),
    )

    const all = await (await app.request("/global/stats")).json()
    expect(all).toMatchObject({
      totalSessions: 2,
      totalMessages: 4,
      totalCost: 0.75,
      totalTokens: { input: 140, output: 20, reasoning: 10, cache: { read: 4, write: 2 } },
      toolUsage: { bash: 2 },
      modelUsage: {
        "alibaba-cn/qwen-plus": { messages: 1, cost: 0.5, tokens: { input: 100, output: 15 } },
        "deepseek/deepseek-chat": { messages: 1, cost: 0.25, tokens: { input: 40, output: 15 } },
      },
    })

    const project = await (await app.request(`/global/stats?project=${recent.projectID}`)).json()
    expect(project).toMatchObject({ totalSessions: 1, totalCost: 0.5 })

    const week = await (await app.request("/global/stats?days=7")).json()
    expect(week).toMatchObject({ totalSessions: 1, totalCost: 0.5, days: 7 })
  })

  test("everything is zero without sessions", async () => {
    const app = Server.App()
    const stats = await (await app.request("/global/stats?project=prj_none")).json()
    expect(stats).toMatchObject({ totalSessions: 0, totalMessages: 0, totalCost: 0, toolUsage: {}, modelUsage: {} })
  })
})
