import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { Identifier } from "@merakcode/util/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { DelegateTool } from "../../src/tool/delegate"
import { Todo } from "../../src/session/todo"
import { create, leave, load, update } from "../../src/collaboration/store"
import { tmpdir } from "../fixture/fixture"

/**
 * A stand-in CLI: appends the prompt it reads on stdin to <log> and "new <id>" or "resume <id>" to <log>.runs, may
 * write a file, and prints its session id and the reply.
 */
const CLI = `import fs from "node:fs"
import path from "node:path"
const [log, reply, write] = process.argv.slice(2)
const resume = process.argv.indexOf("--resume")
const started = Date.now()
let prompt = ""
for await (const chunk of process.stdin) prompt += chunk
await new Promise((resolve) => setTimeout(resolve, Number(process.env.SEAT_DELAY ?? 0)))
fs.appendFileSync(log + ".times", started + " " + Date.now() + "\\n")
fs.appendFileSync(log, prompt + "\\n<<END>>\\n")
const count = fs.readFileSync(log, "utf8").split("\\n<<END>>\\n").length - 1
const id = resume > 0 ? process.argv[resume + 1] : "S-" + path.basename(log) + "-" + count
fs.appendFileSync(log + ".runs", (resume > 0 ? "resume " : "new ") + id + "\\n")
if (write) {
  fs.mkdirSync(path.dirname(write), { recursive: true })
  fs.writeFileSync(write, "changed")
}
process.stdout.write("session: " + id + "\\n" + reply)
`

type Product = { title: string; reply: string; write?: string }

/** A project whose config registers one fake CLI per product */
async function project(products: Record<string, Product>) {
  const tmp = await tmpdir({ git: true })
  const script = path.join(tmp.path, ".cli", "seat.mjs")
  await fs.mkdir(path.dirname(script), { recursive: true })
  await fs.writeFile(script, CLI)
  const collaboration = {
    products: Object.fromEntries(
      Object.entries(products).map(([id, product]) => [
        id,
        {
          command: process.execPath,
          title: product.title,
          args: [script, path.join(tmp.path, ".cli", id), product.reply, ...(product.write ? [product.write] : [])],
          resumeArgs: [script, path.join(tmp.path, ".cli", id), product.reply, "", "--resume", "{id}"],
          sessionLine: "^session: (\\S+)",
        },
      ]),
    ),
  }
  await fs.writeFile(path.join(tmp.path, "merakcode.json"), JSON.stringify({ collaboration }))
  await fs.writeFile(path.join(tmp.path, ".gitignore"), ".cli/\nmerakcode.json\n.gitignore\n")
  const read = (file: string) => fs.readFile(path.join(tmp.path, ".cli", file), "utf8").catch(() => "")
  const prompts = async (id: string) => (await read(id)).split("\n<<END>>\n").filter(Boolean)
  const runs = async (id: string) => (await read(`${id}.runs`)).split("\n").filter(Boolean)
  /** When each run of a product started and ended */
  const times = async (id: string) =>
    (await read(`${id}.times`))
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" ").map(Number) as [number, number])
  return Object.assign(tmp, { prompts, runs, times })
}

/** A user message and the leader's reply to it; returns the reply's id, which a tool call belongs to */
async function turn(sessionID: string, text: string, directory: string) {
  const user = await Session.updateInfo({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID,
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-4" },
    time: { created: Date.now() },
  })
  await Session.updatePart({ id: Identifier.ascending("part"), messageID: user.id, sessionID, type: "text", text })
  const reply = await Session.updateInfo({
    id: Identifier.ascending("message"),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "gpt-4",
    providerID: "openai",
    parentID: user.id,
    time: { created: Date.now() },
  })
  return reply.id
}

async function delegate(
  sessionID: string,
  messageID: string,
  params: { seat: string; task: string; paths?: string[]; todo?: string },
  abort = new AbortController().signal,
) {
  const metadata: Record<string, unknown>[] = []
  const tool = await DelegateTool.init()
  const result = await tool.execute(params, {
    sessionID,
    messageID,
    callID: Identifier.ascending("part"),
    agent: "build",
    abort,
    messages: [],
    ruleset: [],
    metadata: (value) => {
      metadata.push(value.metadata ?? {})
    },
    ask: async () => {},
  })
  return { ...result, phases: metadata.map((item) => item.phase) }
}

test("a member gets one English prompt on stdin: its duty, the user's words, others' results, todo, changes, task last", async () => {
  await using tmp = await project({
    echo: { title: "Echo CLI", reply: "登录入口已改到 src/auth/login.ts", write: "src/auth/login.ts" },
    dump: { title: "Dump CLI", reply: "支付已拆开" },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ metadata: { group: true } })
      await create(session.id, {
        leader: { name: "小主", role: "交付经理", duty: "负责分派" },
        seats: [
          { name: "小红", role: "产品经理", duty: "负责登录", product: "echo" },
          { name: "abc", duty: "负责支付，只改 src/pay", product: "dump" },
        ],
      })
      const messageID = await turn(session.id, "把登录和支付拆开做", tmp.path)
      await delegate(session.id, messageID, { seat: "小红", task: "做登录", paths: ["src/auth/**"] })
      const done = await delegate(session.id, messageID, { seat: "abc", task: "做支付", paths: ["src/pay/**"] })

      expect(done.output).toBe("支付已拆开")
      expect((await tmp.prompts("dump"))[0]).toBe(
        [
          "You are abc (Dump CLI), a member of a group chat in MerakCode.",
          "Your duty:",
          "负责支付，只改 src/pay",
          "",
          "The leader is 小主. Other members: 小红 (Echo CLI, 产品经理).",
          "You cannot see the group chat. Everything you need is below; your earlier work is in your own session.",
          "Do not start other members. If someone else should do something, say so at the end of your reply. The leader decides.",
          "Only change files under: src/pay/**",
          "",
          "User request:",
          "把登录和支付拆开做",
          "",
          "Results so far:",
          "小红: 登录入口已改到 src/auth/login.ts",
          "",
          "Todo:",
          "- [x] @小红 做登录 (src/auth/**)",
          "- [-] @abc 做支付 (src/pay/**)",
          "",
          "Changed files:",
          "- A src/auth/login.ts  小红",
          "",
          "Your task:",
          "做支付",
        ].join("\n"),
      )
    },
  })
})

test("each member resumes its own session; a renamed member keeps it and reads its new name and duty", async () => {
  await using tmp = await project({ echo: { title: "Echo CLI", reply: "好了" } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ metadata: { group: true } })
      const group = await create(session.id, {
        leader: { name: "小主" },
        seats: [
          { name: "小红", duty: "负责登录", product: "echo" },
          { name: "小刚", product: "echo" },
        ],
      })
      const messageID = await turn(session.id, "开始", tmp.path)
      await delegate(session.id, messageID, { seat: "小红", task: "一" })
      await delegate(session.id, messageID, { seat: "小刚", task: "二" })
      await delegate(session.id, messageID, { seat: "小红", task: "三" })
      await update(session.id, group.seats[1]!.id, { name: "小芳", duty: "负责支付" })
      await delegate(session.id, messageID, { seat: "小芳", task: "四" })

      expect(await tmp.runs("echo")).toEqual(["new S-echo-1", "new S-echo-2", "resume S-echo-1", "resume S-echo-1"])
      const last = (await tmp.prompts("echo")).at(-1)!
      expect(
        last.startsWith("You are 小芳 (Echo CLI), a member of a group chat in MerakCode.\nYour duty:\n负责支付\n"),
      ).toBe(true)
      await expect(delegate(session.id, messageID, { seat: "小红", task: "五" })).rejects.toThrow(
        "No member is named 小红",
      )
    },
  })
})

test("a member whose command is not installed does not start, and its todo item stays open", async () => {
  await using tmp = await project({})
  await fs.writeFile(
    path.join(tmp.path, "merakcode.json"),
    JSON.stringify({ collaboration: { products: { gone: { command: "merak-missing-cli", title: "Gone CLI" } } } }),
  )
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ metadata: { group: true } })
      await create(session.id, { leader: { name: "小主" }, seats: [{ name: "小红", product: "gone" }] })
      const messageID = await turn(session.id, "开始", tmp.path)
      const done = await delegate(session.id, messageID, { seat: "小红", task: "做登录" })
      expect(done.output).toBe("Gone CLI is not installed, so 小红 did not start.")
      expect(done.metadata).toMatchObject({ missing: true })
      expect((await Todo.get(session.id)).map((item) => [item.content, item.status])).toEqual([
        ["@小红 做登录", "pending"],
      ])
      expect((await load(session.id))?.results).toEqual([])
    },
  })
})

test("a member is named by its name, not its product, and a suggestion in a reply starts no one", async () => {
  await using tmp = await project({
    echo: { title: "Echo CLI", reply: "登录做完了\n建议 @小刚：补登录测试" },
    other: { title: "Other CLI", reply: "测试补好了" },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ metadata: { group: true } })
      await create(session.id, {
        leader: { name: "小主" },
        seats: [
          { name: "小红", product: "echo" },
          { name: "小刚", product: "other" },
        ],
      })
      const messageID = await turn(session.id, "开始", tmp.path)
      await expect(delegate(session.id, messageID, { seat: "echo", task: "做登录" })).rejects.toThrow(
        "No member is named echo. Members: 小红, 小刚",
      )
      const done = await delegate(session.id, messageID, { seat: "小红", task: "做登录" })
      expect(done.output).toBe("登录做完了\n建议 @小刚：补登录测试")
      expect(await tmp.runs("other")).toEqual([])
    },
  })
})

const overlapping = ([a, b]: [number, number], [c, d]: [number, number]) => a < d && c < b

test("members run together only when their paths cannot touch the same file", async () => {
  process.env.SEAT_DELAY = "300"
  await using tmp = await project({
    a: { title: "A CLI", reply: "a" },
    b: { title: "B CLI", reply: "b" },
  })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ metadata: { group: true } })
        await create(session.id, {
          leader: { name: "小主" },
          seats: [
            { name: "小红", product: "a" },
            { name: "abc", product: "b" },
          ],
        })
        const messageID = await turn(session.id, "开始", tmp.path)
        const pair = async (left: string[] | undefined, right: string[] | undefined) => {
          await Promise.all([
            delegate(session.id, messageID, { seat: "小红", task: "做", paths: left }),
            delegate(session.id, messageID, { seat: "abc", task: "做", paths: right }),
          ])
          return overlapping((await tmp.times("a")).at(-1)!, (await tmp.times("b")).at(-1)!)
        }
        expect(await pair(["src/auth/**"], ["src/pay/**"])).toBe(true)
        expect(await pair(["src/auth/**"], ["src/auth/login.ts"])).toBe(false)
        expect(await pair(["src/auth/**"], undefined)).toBe(false)
        expect(await pair(["src/**/*.ts"], ["docs/**"])).toBe(false)

        await Promise.all([
          delegate(session.id, messageID, { seat: "小红", task: "一", paths: ["src/a/**"] }),
          delegate(session.id, messageID, { seat: "小红", task: "二", paths: ["src/b/**"] }),
        ])
        const [first, second] = (await tmp.times("a")).slice(-2)
        expect(overlapping(first!, second!)).toBe(false)
      },
    })
  } finally {
    delete process.env.SEAT_DELAY
  }
})

test("a member that waited for another one reads that one's result", async () => {
  process.env.SEAT_DELAY = "200"
  await using tmp = await project({
    a: { title: "A CLI", reply: "登录接口叫 login()" },
    b: { title: "B CLI", reply: "测试写好了" },
  })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ metadata: { group: true } })
        await create(session.id, {
          leader: { name: "小主" },
          seats: [
            { name: "小红", product: "a" },
            { name: "小刚", product: "b" },
          ],
        })
        const messageID = await turn(session.id, "开始", tmp.path)
        await Promise.all([
          delegate(session.id, messageID, { seat: "小红", task: "做登录", paths: ["src/auth/**"] }),
          delegate(session.id, messageID, { seat: "小刚", task: "补测试", paths: ["src/auth/login.test.ts"] }),
        ])
        expect((await tmp.prompts("b"))[0]).toContain("Results so far:\n小红: 登录接口叫 login()")
      },
    })
  } finally {
    delete process.env.SEAT_DELAY
  }
})

const statuses = async (sessionID: string) => (await Todo.get(sessionID)).map((item) => [item.content, item.status])

test("a delegation drives the todo item it names, or adds one; a failure reopens it and a stop cancels it", async () => {
  process.env.SEAT_DELAY = "300"
  await using tmp = await project({ echo: { title: "Echo CLI", reply: "好了" } })
  await fs.writeFile(path.join(tmp.path, ".cli", "fail.mjs"), "process.stderr.write('boom'); process.exit(2)")
  const config = JSON.parse(await fs.readFile(path.join(tmp.path, "merakcode.json"), "utf8"))
  config.collaboration.products.fail = { command: process.execPath, args: [path.join(tmp.path, ".cli", "fail.mjs")] }
  await fs.writeFile(path.join(tmp.path, "merakcode.json"), JSON.stringify(config))
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ metadata: { group: true } })
        await create(session.id, {
          leader: { name: "小主" },
          seats: [
            { name: "小红", product: "echo" },
            { name: "小刚", product: "fail" },
          ],
        })
        await Todo.update({
          sessionID: session.id,
          todos: [{ id: "t1", content: "@小红 改登录页 (src/auth/**)", status: "pending", priority: "high" }],
        })
        const messageID = await turn(session.id, "开始", tmp.path)
        const running = delegate(session.id, messageID, { seat: "小红", task: "做登录", todo: "t1" })
        await new Promise((resolve) => setTimeout(resolve, 150))
        expect(await statuses(session.id)).toEqual([["@小红 改登录页 (src/auth/**)", "in_progress"]])
        await running
        expect(await statuses(session.id)).toEqual([["@小红 改登录页 (src/auth/**)", "completed"]])

        // stderr goes to the log only; the leader and the chat see that the member gave no reply
        const failure = await delegate(session.id, messageID, {
          seat: "小刚",
          task: "补测试",
          paths: ["test/**"],
        }).catch((error: Error) => error.message)
        expect(failure).toBe("fail returned no reply (exit code 2)")
        expect((await statuses(session.id)).at(-1)).toEqual(["@小刚 补测试 (test/**)", "pending"])

        const stop = new AbortController()
        const stopped = delegate(session.id, messageID, { seat: "小红", task: "做支付" }, stop.signal)
        await new Promise((resolve) => setTimeout(resolve, 150))
        stop.abort()
        await stopped.catch(() => undefined)
        expect((await statuses(session.id)).at(-1)).toEqual(["@小红 做支付", "cancelled"])
      },
    })
  } finally {
    delete process.env.SEAT_DELAY
  }
})

test("members finishing together and a todo rewrite in the same step lose no update", async () => {
  await using tmp = await project({
    a: { title: "A CLI", reply: "a" },
    b: { title: "B CLI", reply: "b" },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ metadata: { group: true } })
      await create(session.id, {
        leader: { name: "小主" },
        seats: [
          { name: "小红", product: "a" },
          { name: "abc", product: "b" },
        ],
      })
      const messageID = await turn(session.id, "开始", tmp.path)
      await Promise.all([
        delegate(session.id, messageID, { seat: "小红", task: "做登录", paths: ["src/auth/**"] }),
        delegate(session.id, messageID, { seat: "abc", task: "做支付", paths: ["src/pay/**"] }),
      ])
      expect(await statuses(session.id)).toEqual([
        ["@小红 做登录 (src/auth/**)", "completed"],
        ["@abc 做支付 (src/pay/**)", "completed"],
      ])
      expect((await load(session.id))?.results.map((item) => item.name).toSorted()).toEqual(["abc", "小红"])
    },
  })
})

test("a removed member gets no more work, and the other member of the same product still does", async () => {
  await using tmp = await project({ echo: { title: "Echo CLI", reply: "好了" } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ metadata: { group: true } })
      const group = await create(session.id, {
        leader: { name: "小主" },
        seats: [
          { name: "小红", product: "echo" },
          { name: "小刚", product: "echo" },
        ],
      })
      await leave(session.id, group.seats.find((seat) => seat.name === "小刚")!.id)
      const messageID = await turn(session.id, "开始", tmp.path)
      await expect(delegate(session.id, messageID, { seat: "小刚", task: "补测试" })).rejects.toThrow(
        "No member is named 小刚. Members: 小红",
      )
      expect((await delegate(session.id, messageID, { seat: "小红", task: "做登录" })).output).toBe("好了")
      expect(await tmp.runs("echo")).toHaveLength(1)
    },
  })
})

test("a member that waited in the queue counts its working time from when it started, not from when it was asked", async () => {
  process.env.SEAT_DELAY = "400"
  await using tmp = await project({ echo: { title: "Echo CLI", reply: "好了" } })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ metadata: { group: true } })
        await create(session.id, { leader: { name: "小主" }, seats: [{ name: "小红", product: "echo" }] })
        const messageID = await turn(session.id, "开始", tmp.path)
        const asked = Date.now()
        const [, second] = await Promise.all([
          delegate(session.id, messageID, { seat: "小红", task: "一" }),
          delegate(session.id, messageID, { seat: "小红", task: "二" }),
        ])
        const started = (second.metadata as { started?: number }).started
        expect(started).toBeGreaterThanOrEqual(asked + 350)
      },
    })
  } finally {
    delete process.env.SEAT_DELAY
  }
})

test("turning a product off leaves the members already using it working", async () => {
  await using tmp = await project({ echo: { title: "Echo CLI", reply: "好了" } })
  const file = path.join(tmp.path, "merakcode.json")
  const config = JSON.parse(await fs.readFile(file, "utf8"))
  config.collaboration.products.echo.enabled = false
  await fs.writeFile(file, JSON.stringify(config))
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ metadata: { group: true } })
      await create(session.id, { leader: { name: "小主" }, seats: [{ name: "小红", product: "echo" }] })
      const messageID = await turn(session.id, "开始", tmp.path)
      expect((await delegate(session.id, messageID, { seat: "小红", task: "做" })).output).toBe("好了")
    },
  })
})
