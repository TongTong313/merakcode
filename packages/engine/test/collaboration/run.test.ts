import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { Product } from "@merakcode/sdk/adapter"
import { tmpdir } from "../fixture/fixture"
import { runMember } from "../../src/collaboration/member"
import { adapterOf, builtinLaunch } from "../../src/collaboration/adapters"
import { whichInstalled } from "../../src/collaboration/locate"

/** One task for a one-shot product, run through the built-in command adapter */
function oneShot(
  product: Omit<Product, "id" | "title">,
  cwd: string,
  input: { prompt: string; resume?: string; abort?: AbortSignal },
) {
  return runMember({
    launch: builtinLaunch("command"),
    product: { id: "custom", title: "Custom", ...product },
    task: { prompt: input.prompt, cwd, mode: "ask", resume: input.resume },
    abort: input.abort ?? new AbortController().signal,
    host: { step: () => {}, permission: async () => ({ allow: true }), question: async () => [] },
  })
}

const script = `
import fs from "node:fs"
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const prompt = Buffer.concat(chunks).toString()
fs.writeFileSync(process.argv[2], prompt)
fs.writeFileSync("created.txt", "ok")
process.stdout.write("支付已写到 src/pay/checkout.ts\\n")
`

test("a one-shot command receives the prompt on stdin, can write the workspace, and its output is the reply", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "seat.mjs")
  const promptFile = path.join(tmp.path, "prompt.txt")
  await fs.writeFile(file, script)
  const result = await oneShot({ command: process.execPath, args: [file, promptFile] }, tmp.path, {
    prompt: "做支付。只改 src/pay/**。",
  })
  expect(result.text).toBe("支付已写到 src/pay/checkout.ts")
  expect(await fs.readFile(promptFile, "utf8")).toBe("做支付。只改 src/pay/**。")
  expect(await fs.readFile(path.join(tmp.path, "created.txt"), "utf8")).toBe("ok")
}, 30_000)

test("stopping a one-shot member ends its command, and what the command started, as with an npm shim", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "wait.mjs")
  const pidFile = path.join(tmp.path, "pid")
  await fs.writeFile(
    file,
    `import fs from "node:fs"\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\nsetInterval(() => {}, 1000)\n`,
  )
  const shim = process.platform === "win32" ? path.join(tmp.path, "seat.cmd") : path.join(tmp.path, "seat")
  await fs.writeFile(
    shim,
    process.platform === "win32"
      ? `@"${process.execPath}" "${file}" %*\r\n`
      : `#!/bin/sh\n"${process.execPath}" "${file}"\n`,
    { mode: 0o755 },
  )
  const abort = new AbortController()
  const pending = oneShot({ command: shim, args: [] }, tmp.path, { prompt: "wait", abort: abort.signal })
  await expect
    .poll(
      () =>
        fs.access(pidFile).then(
          () => true,
          () => false,
        ),
      { timeout: 10_000 },
    )
    .toBe(true)
  abort.abort()
  await expect(pending).rejects.toThrow()
  const pid = Number(await fs.readFile(pidFile, "utf8"))
  const alive = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  await expect.poll(alive, { timeout: 10_000, interval: 200 }).toBe(false)
}, 30_000)

test("a one-shot command's session line gives its session, and the next task resumes it", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "text-seat.mjs")
  await fs.writeFile(
    file,
    `
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
process.stdout.write(Buffer.concat(chunks).toString())
process.stdout.write("\\nSESSION " + (process.argv.includes("resume") ? process.argv.at(-1) : "sess-9"))
`,
  )
  const product = {
    command: process.execPath,
    args: [file],
    resumeArgs: [file, "resume", "{id}"],
    sessionLine: "^SESSION (\\S+)",
  }
  const first = await oneShot(product, tmp.path, { prompt: "第一次" })
  expect(first.text).toBe("第一次")
  expect(first.sessionId).toBe("sess-9")
  const second = await oneShot(product, tmp.path, { prompt: "第二次", resume: first.sessionId })
  expect(second.text).toBe("第二次")
  expect(second.sessionId).toBe("sess-9")
}, 30_000)

test("a one-shot command is only looked for, never run, to tell whether it is there", async () => {
  await using tmp = await tmpdir()
  const ran = path.join(tmp.path, "ran.txt")
  const file = path.join(tmp.path, "agent.mjs")
  await fs.writeFile(file, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(ran)}, "ran")`)
  const { inspectMember } = await import("../../src/collaboration/member")
  const info = await inspectMember({
    launch: builtinLaunch("command"),
    product: { id: "custom", title: "Custom", command: process.execPath, args: [file] },
    cwd: tmp.path,
  })
  expect(info).toMatchObject({ name: "Custom", path: process.execPath })
  expect(info.unavailable).toBeUndefined()
  await delay(200)
  await expect(fs.access(ran)).rejects.toThrow()
}, 30_000)

test("a claude.exe outside PATH is still found", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "claude.exe")
  await fs.writeFile(file, "")
  expect(whichInstalled("claude", () => null, [tmp.path])).toBe(file)
})

test("a product run with node gets MerakCode's own Node, so it runs on a machine without one", async () => {
  await using empty = await tmpdir()
  const saved = { PATH: process.env.PATH, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA }
  for (const key of Object.keys(saved)) process.env[key] = empty.path
  try {
    const fixture = path.join(import.meta.dirname, "fixture", "adapter.ts")
    const driven = adapterOf({
      id: "mine",
      title: "Mine",
      command: "node",
      adapter: "member",
      args: [...process.execArgv, fixture, JSON.stringify({ reply: "我在" })],
    })
    expect(driven?.launch[0]).toBe(process.execPath)
    const result = await runMember({
      ...driven!,
      task: { prompt: "在吗", cwd: empty.path, mode: "ask" },
      abort: new AbortController().signal,
      host: { step: () => {}, permission: async () => ({ allow: true }), question: async () => [] },
    })
    expect(result.text).toBe("我在")
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
  }
}, 60_000)

test("overriding only the command of a built-in product keeps the rest of it, its adapter included", async () => {
  const { Instance } = await import("../../src/project/instance")
  const { configuredProducts } = await import("../../src/collaboration/run")
  await using tmp = await tmpdir({
    config: { collaboration: { products: { claude: { command: "/opt/claude/bin/claude" } } } },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const claude = (await configuredProducts()).find((product) => product.id === "claude")!
      expect(claude).toMatchObject({
        command: "/opt/claude/bin/claude",
        title: "Claude Code",
        adapter: "claude",
        args: [],
      })
    },
  })
})
