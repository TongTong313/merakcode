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
