/**
 * SDK contract: permission and question callbacks. The model writes a file or asks a question and the host answers in
 * the callback.
 */
import { afterAll, beforeAll, expect, test } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { createMerakCode, type MerakCode } from "@merakcode/sdk"
import { engine, sandbox, type Sandbox } from "../fixture/engine"
import { fakeModel, type Reply, type Turn } from "../fixture/model"

let script: (turn: Turn) => Reply = () => ({ text: "OK" })
let model: Awaited<ReturnType<typeof fakeModel>>
let env: Sandbox
let merak: MerakCode

beforeAll(async () => {
  model = await fakeModel((turn) => script(turn))
  env = await sandbox(model.url, { permission: { edit: "ask" } })
  merak = await createMerakCode({ cwd: env.project, executablePath: engine, env: env.env })
}, 120_000)

afterAll(async () => {
  await merak?.close()
  await model?.close()
  await env?.[Symbol.asyncDispose]()
})

/** The first request makes the model write a file; once it has the tool result, it repeats the result verbatim */
const writeThenReport = (file: string) => (turn: Turn) =>
  turn.results.length === 0
    ? { tool: "write", args: { filePath: file, content: "hello" } }
    : { text: `结果：${turn.results[0]}` }

test("when the permission callback allows, the file is written and the callback sees the edit request", async () => {
  const file = path.join(env.project, "allowed.txt")
  script = writeThenReport(file)
  const session = await merak.session()
  const asked: string[] = []
  for await (const _ of session.run("写个文件", {
    mode: "ask",
    onPermission: async (request) => {
      asked.push(request.permission)
      return "allow-once"
    },
  })) {
  }
  expect(asked).toContain("edit")
  expect(readFileSync(file, "utf8")).toBe("hello")
}, 120_000)

test("when the permission callback denies, no file is written and the model gets the rejection", async () => {
  const file = path.join(env.project, "denied.txt")
  script = writeThenReport(file)
  const session = await merak.session()
  let text = ""
  for await (const event of session.run("写个文件", { mode: "ask", onPermission: async () => "deny" })) {
    if (event.type === "text") text += event.delta
  }
  expect(existsSync(file)).toBe(false)
  expect(text).toMatch(/结果：.*(reject|denied|拒绝)/i)
}, 120_000)

test("the question callback picks the first option and the model receives the answer", async () => {
  script = (turn) =>
    turn.results.length === 0
      ? {
          tool: "question",
          args: {
            questions: [
              {
                question: "用哪种语言？",
                header: "语言",
                options: [
                  { label: "TypeScript", description: "类型安全" },
                  { label: "Python", description: "写得快" },
                ],
              },
            ],
          },
        }
      : { text: `答案：${turn.results[0]}` }
  const session = await merak.session()
  let text = ""
  const asked: string[] = []
  for await (const event of session.run("问我一个问题", {
    onQuestion: async (request) => {
      asked.push(request.questions[0]!.question)
      return request.questions.map((question) => [question.options[0]!.label])
    },
  })) {
    if (event.type === "text") text += event.delta
  }
  expect(asked).toEqual(["用哪种语言？"])
  expect(text).toContain("TypeScript")
}, 120_000)

/** The main session starts a general subagent, which asks a question, then reports the answer it got */
const subagentAsks = (turn: Turn): Reply => {
  if (turn.prompt.includes("SUBTASK")) {
    if (turn.results.length > 0) return { text: `子智能体：${turn.results[0]}` }
    return {
      tool: "question",
      args: {
        questions: [
          {
            question: "子智能体想知道用哪种语言？",
            header: "语言",
            options: [
              { label: "TypeScript", description: "类型安全" },
              { label: "Python", description: "写得快" },
            ],
          },
        ],
      },
    }
  }
  if (turn.results.length === 0)
    return { tool: "subagent", args: { description: "问问题", prompt: "SUBTASK", subagent_type: "general" } }
  return { text: `汇总：${turn.results[0]}` }
}

test("a subagent's question goes to the question callback of the conversation that started it", async () => {
  script = subagentAsks
  const session = await merak.session()
  let text = ""
  const asked: string[] = []
  for await (const event of session.run("让子智能体问我", {
    signal: AbortSignal.timeout(90_000),
    onPermission: () => "allow-once",
    onQuestion: async (request) => {
      asked.push(request.questions[0]!.question)
      return request.questions.map((question) => [question.options[0]!.label])
    },
  })) {
    if (event.type === "text") text += event.delta
  }
  expect(asked).toEqual(["子智能体想知道用哪种语言？"])
  expect(text).toContain("TypeScript")
}, 120_000)

test("without a question callback a subagent's question is dismissed, so the turn ends instead of waiting", async () => {
  script = subagentAsks
  const session = await merak.session()
  let text = ""
  for await (const event of session.run("让子智能体问我", {
    signal: AbortSignal.timeout(90_000),
    onPermission: () => "allow-once",
  })) {
    if (event.type === "text") text += event.delta
  }
  expect(text).toContain("汇总：")
  expect((await merak.client.question.list()).data).toEqual([])
}, 120_000)
