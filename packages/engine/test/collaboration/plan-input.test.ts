import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { runMember } from "../../src/agent/external/runtime"
import { Token } from "../../src/agent/context/token"
import { tmpdir } from "../fixture/fixture"

test("cancellation while saving a snapshot sends no subsequent task to the real adapter", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "received")
  const script = `const fs=require("node:fs"),readline=require("node:readline")
readline.createInterface({input:process.stdin}).on("line",line=>{
 const q=JSON.parse(line);fs.appendFileSync(process.argv[1],q.method+"\\n");if(q.id===undefined)return
 process.stdout.write(JSON.stringify({id:q.id,result:q.method==="initialize"?{protocol:3,name:"Cancellation fixture",capabilities:{modelSelection:false,modelDiscovery:false,textStreaming:false,resume:false,permission:"merak",questions:false}}:{text:"DONE"}})+"\\n")
})`
  const controller = new AbortController()
  const running = runMember({
    launch: [process.execPath, "-e", script, file],
    product: { id: "cancel", title: "Cancel" },
    task: { prompt: "Do not launch after cancellation", cwd: tmp.path, permissionLevel: "fullTakeover" },
    abort: controller.signal,
    beforeTask: async () => {
      controller.abort(new Error("Cancelled before dispatch"))
    },
    host: { step: () => {}, permission: async () => ({ allow: false, message: "No tools" }), question: async () => [] },
  })
  await expect(running).rejects.toThrow()
  expect((await fs.readFile(file, "utf8")).trim().split("\n")).not.toContain("task/run")
})

test.each(["complete", "missing", "small"] as const)(
  "external plan input checks %s capacity before dispatch",
  async (kind) => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "task")
    const capacity =
      kind === "missing"
        ? undefined
        : { fullInput: true, contextTokens: kind === "small" ? 6500 : 8000, reservedTokens: 0, fixedInputTokens: 100 }
    const script = `
    const fs=require("node:fs"),readline=require("node:readline")
    readline.createInterface({input:process.stdin}).on("line",line=>{
      const q=JSON.parse(line);if(q.id===undefined)return
      if(q.method==="task/run")fs.writeFileSync(process.argv[1],JSON.stringify(q.params))
      const result=q.method==="initialize"?{protocol:3,name:"Plan fixture",capabilities:{modelSelection:false,modelDiscovery:false,textStreaming:false,resume:false,permission:"merak",questions:false,plan:${JSON.stringify(capacity) ?? "undefined"}}}:{text:"DONE"}
      process.stdout.write(JSON.stringify({id:q.id,result})+"\\n")
    })`
    const content = "x".repeat(24000)
    const task = {
      prompt: "Execute the plan",
      cwd: tmp.path,
      permissionLevel: "fullTakeover" as const,
      plan: { content, revision: 1 },
    }
    const pending = runMember({
      launch: [process.execPath, "-e", script, file],
      product: { id: "plan", title: "Plan" },
      task,
      abort: new AbortController().signal,
      host: {
        step: () => {},
        permission: async () => ({ allow: false, message: "Tools disabled" }),
        question: async () => [],
      },
    })
    if (kind !== "complete") {
      await expect(pending).rejects.toThrow()
      await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" })
      return
    }
    await pending
    const received = JSON.parse(await fs.readFile(file, "utf8"))
    expect(received.plan.content).toBe(content)
    expect(received.prompt.includes(content)).toBe(true)
  },
)

test.each([
  ["zh-CN", 6000, 1000],
  ["en-US", 6000, 1000],
  ["zh-CN", 10000, 1000],
  ["en-US", 10000, 1000],
  ["zh-CN", 26000, 2600],
  ["en-US", 26000, 2600],
] as const)(
  "external capacity at %s and %d tokens distinguishes body from reserve",
  async (locale, tokens, margin) => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "received")
    const previous = process.env.MERAKCODE_LOCALE
    process.env.MERAKCODE_LOCALE = locale
    const content = "x".repeat(tokens * 4)
    const execute = async (contextTokens: number) => {
      await fs.rm(file, { force: true })
      const script = `const fs=require("node:fs"),readline=require("node:readline")
      readline.createInterface({input:process.stdin}).on("line",line=>{
        const q=JSON.parse(line);if(q.id===undefined)return
        if(q.method==="task/run")fs.writeFileSync(process.argv[1],JSON.stringify(q.params))
        const result=q.method==="initialize"?{protocol:3,name:"Exact capacity",capabilities:{modelSelection:false,modelDiscovery:false,textStreaming:false,resume:false,permission:"external",questions:false,plan:{fullInput:true,contextTokens:${contextTokens},reservedTokens:0,fixedInputTokens:100}}}:{text:"DONE"}
        process.stdout.write(JSON.stringify({id:q.id,result})+"\\n")
      })`
      return runMember({
        launch: [process.execPath, "-e", script, file],
        product: { id: "capacity", title: "Capacity" },
        task: {
          prompt: "Execute the plan",
          cwd: tmp.path,
          permissionLevel: "fullTakeover",
          plan: { content, revision: 1 },
        },
        abort: new AbortController().signal,
        host: {
          step: () => {},
          permission: async () => ({ allow: false, message: "No tools" }),
          question: async () => [],
        },
      })
    }
    try {
      await execute(200000)
      const received = JSON.parse(await fs.readFile(file, "utf8"))
      const requestTokens = Token.estimate(received.prompt) + 100
      expect(Token.estimate(content)).toBe(tokens)
      await expect(execute(requestTokens + margin)).resolves.toMatchObject({ text: "DONE" })
      await expect(execute(requestTokens + margin - 1)).rejects.toMatchObject({
        name: "PlanCapacityError",
        data: {
          reason: "reserve",
          deficit: 1,
          message: expect.stringMatching(locale === "zh-CN" ? /安全余量/ : /safety reserve/),
        },
      })
      await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" })
      await expect(execute(requestTokens - 1)).rejects.toMatchObject({
        name: "PlanCapacityError",
        data: {
          reason: "body",
          deficit: margin + 1,
          message: expect.stringMatching(locale === "zh-CN" ? /完整请求/ : /complete request/),
        },
      })
      await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      if (previous === undefined) delete process.env.MERAKCODE_LOCALE
      else process.env.MERAKCODE_LOCALE = previous
    }
  },
  15000,
)
