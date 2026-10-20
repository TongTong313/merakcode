/**
 * SDK contract: custom tools are defined in the host process; when the model calls one, the engine calls back into
 * the host to run it and returns the result to the model.
 */
import { afterAll, beforeAll, expect, test } from "vitest"
import { z } from "zod"
import { createMerakCode, tool, type MerakCode } from "@merakcode/sdk"
import { engine, sandbox, type Sandbox } from "../fixture/engine"
import { fakeModel, type Reply, type Turn } from "../fixture/model"

let script: (turn: Turn) => Reply = () => ({ text: "OK" })
let model: Awaited<ReturnType<typeof fakeModel>>
let env: Sandbox
let merak: MerakCode
const calls: { id: string; sessionID: string }[] = []

beforeAll(async () => {
  model = await fakeModel((turn) => script(turn))
  env = await sandbox(model.url)
  merak = await createMerakCode({
    cwd: env.project,
    executablePath: engine,
    env: env.env,
    tools: [
      tool({
        name: "jira",
        description: "查 Jira 单的标题",
        args: { id: z.string().describe("单号") },
        run: async ({ id }, context) => {
          calls.push({ id, sessionID: context.sessionID })
          return `单 ${id} 的标题是「登录页白屏」`
        },
      }),
      tool({
        name: "broken",
        description: "总是失败",
        args: {},
        run: async () => {
          throw new Error("服务不可用")
        },
      }),
    ],
  })
}, 120_000)

afterAll(async () => {
  await merak?.close()
  await model?.close()
  await env?.[Symbol.asyncDispose]()
})

test("the model sees a custom tool, the host runs it on call and the result goes back to the model", async () => {
  script = (turn) =>
    turn.results.length === 0 ? { tool: "jira", args: { id: "MC-42" } } : { text: `工具说：${turn.results[0]}` }
  const session = await merak.session()
  let text = ""
  for await (const event of session.run("查一下 MC-42", { onPermission: () => "allow-once" }))
    if (event.type === "text") text += event.delta
  expect(model.turns.at(-1)?.tools).toContain("jira")
  expect(calls).toEqual([{ id: "MC-42", sessionID: session.id }])
  expect(text).toBe("工具说：单 MC-42 的标题是「登录页白屏」")
}, 120_000)

test("when a tool throws, the model gets the error message and the turn ends normally", async () => {
  script = (turn) => (turn.results.length === 0 ? { tool: "broken", args: {} } : { text: `出错了：${turn.results[0]}` })
  const session = await merak.session()
  let text = ""
  for await (const event of session.run("试试 broken", { mode: "auto" })) if (event.type === "text") text += event.delta
  expect(text).toContain("服务不可用")
}, 120_000)

test("host tools need approval like plugin tools: without a callback they are denied and not run", async () => {
  script = (turn) =>
    turn.results.length === 0 ? { tool: "jira", args: { id: "MC-7" } } : { text: `结果：${turn.results[0]}` }
  const before = calls.length
  const session = await merak.session()
  let text = ""
  for await (const event of session.run("查一下 MC-7")) if (event.type === "text") text += event.delta
  expect(calls.length).toBe(before)
  expect(text).toMatch(/结果：.*reject/i)
}, 120_000)
