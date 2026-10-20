/**
 * SDK contract: custom agents, subagents, workflows, and interrupting and resuming sessions.
 */
import { afterAll, beforeAll, expect, test } from "vitest"
import { existsSync } from "node:fs"
import path from "node:path"
import { createMerakCode, type MerakCode } from "@merakcode/sdk"
import { engine, sandbox, type Sandbox } from "../fixture/engine"
import { fakeModel, type Reply, type Turn } from "../fixture/model"

let script: (turn: Turn) => Reply | Promise<Reply> = () => ({ text: "OK" })
let model: Awaited<ReturnType<typeof fakeModel>>
let env: Sandbox
let merak: MerakCode

beforeAll(async () => {
  model = await fakeModel((turn) => script(turn))
  env = await sandbox(model.url)
  merak = await createMerakCode({
    cwd: env.project,
    executablePath: engine,
    env: env.env,
    agents: {
      reviewer: {
        prompt: "REVIEWER_PROMPT 只评审不改代码",
        description: "评审代码",
        tools: { edit: false, write: false, bash: false },
      },
      helper: { prompt: "HELPER_PROMPT", description: "帮忙查资料", mode: "subagent" },
    },
  })
}, 120_000)

afterAll(async () => {
  await merak?.close()
  await model?.close()
  await env?.[Symbol.asyncDispose]()
})

async function collect(iterable: AsyncIterable<{ type: string; delta?: string }>) {
  let text = ""
  for await (const event of iterable) if (event.type === "text") text += event.delta
  return text
}

test("a custom agent uses its prompt, and tools it disables are denied even in auto mode", async () => {
  const file = path.join(env.project, "reviewer.txt")
  script = (turn) =>
    turn.results.length === 0
      ? { tool: "write", args: { filePath: file, content: "x" } }
      : { text: `评审完毕：${turn.results[0]}` }
  const session = await merak.session()
  const text = await collect(session.run("看看这段代码", { agent: "reviewer", mode: "auto" }))
  expect(model.turns.at(-1)!.system).toContain("REVIEWER_PROMPT")
  expect(text).toMatch(/评审完毕：.*(denied|reject|not allowed|prevents)/i)
  expect(existsSync(file)).toBe(false)
}, 120_000)

test("the main session delegates to a custom subagent and gets its reply", async () => {
  script = (turn) => {
    if (turn.system.includes("HELPER_PROMPT")) return { text: "子智能体查到了：42" }
    if (turn.results.length === 0)
      return { tool: "subagent", args: { description: "查资料", prompt: "查一下答案", subagent_type: "helper" } }
    return { text: `汇总：${turn.results[0]}` }
  }
  const session = await merak.session()
  const text = await collect(session.run("找人帮忙查", { mode: "auto" }))
  expect(text).toContain("子智能体查到了：42")
}, 120_000)

test("a workflow script runs two agents in parallel and returns their results to the main session", async () => {
  const workflow = [
    "export const meta = { name: 'pair', description: '两个智能体', phases: [{ title: 'Work' }] }",
    "const [a, b] = await parallel([() => agent('任务甲', { label: 'a', phase: 'Work' }), () => agent('任务乙', { label: 'b', phase: 'Work' })])",
    "return { a, b }",
  ].join("\n")
  script = (turn) => {
    if (turn.prompt.includes("任务甲")) return { text: "甲完成" }
    if (turn.prompt.includes("任务乙")) return { text: "乙完成" }
    // The notification turn the engine posts when the workflow finishes: repeat the results it contains
    if (turn.prompt.includes("workflow-notification")) return { text: `工作流结果：${turn.prompt}` }
    if (turn.results.length === 0) return { tool: "workflow_run", args: { script: workflow } }
    return { text: `已启动：${turn.results[0]}` }
  }
  const session = await merak.session()
  // The workflow runs in the background: the launching turn ends first, and when the workflow finishes the engine
  // posts another turn to the session, so keep waiting with events()
  const abort = new AbortController()
  const later = (async () => {
    // The launching turn shows up here too; the one we want is the turn after the workflow finishes
    let text = ""
    for await (const event of session.events({ signal: abort.signal })) {
      if (event.type === "text") text += event.delta
      if (event.type === "done" && text.includes("甲完成")) return text
    }
    return text
  })()
  const first = await collect(session.run("用工作流跑两个任务", { mode: "auto" }))
  expect(first).toContain("Workflow launched in background")
  const text = await later
  abort.abort()
  expect(text).toContain("甲完成")
  expect(text).toContain("乙完成")
}, 180_000)

test("aborting the run signal stops the turn and the session stays usable", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  script = async (turn) => {
    if (turn.prompt === "慢任务") await gate
    return { text: "接着来" }
  }
  const session = await merak.session()
  const abort = new AbortController()
  const slow = collect(session.run("慢任务", { signal: abort.signal }))
  await until(() => model.turns.some((turn) => turn.prompt === "慢任务"))
  abort.abort()
  await expect(slow).rejects.toThrow()
  release()
  expect(await collect(session.run("下一句"))).toBe("接着来")
}, 120_000)

test("resuming a session by id continues the conversation with its history", async () => {
  script = (turn) => ({ text: `第${turn.prompt}轮` })
  const first = await merak.session()
  await collect(first.run("1"))
  const again = await merak.session({ id: first.id })
  expect(await collect(again.run("2"))).toBe("第2轮")
  const messages = await again.messages()
  expect(messages.filter((message) => message.info.role === "user")).toHaveLength(2)
}, 120_000)

async function until(check: () => boolean, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition")
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
