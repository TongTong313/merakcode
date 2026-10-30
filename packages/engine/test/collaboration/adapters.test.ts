import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import readline from "node:readline"
import type { Mode, Permission, Question, Step } from "@merakcode/sdk/adapter"
import { runMember } from "../../src/agent/external/runtime"
import { builtinLaunch } from "../../src/agent/external/adapters"
import { tmpdir } from "../fixture/fixture"
import { shim } from "./fixture/shim"

/**
 * Runs one task through a built-in adapter against a fake CLI. The host allows what allow says yes to, answers
 * questions with answer, and records everything it was asked.
 */
async function run(input: {
  adapter: "claude" | "codex" | "opencode"
  mode?: Mode
  resume?: string
  env: Record<string, string>
  allow?: (request: Permission) => boolean
  answer?: (questions: Question[]) => string[][]
}) {
  await using tmp = await tmpdir()
  const command = await shim(tmp.path, input.adapter, `${input.adapter}.ts`)
  const argsFile = path.join(tmp.path, "args.json")
  const asked: Permission[] = []
  const questions: Question[][] = []
  const steps: Step[] = []
  // Set on process.env itself (replacing the object would hide later changes from child processes) and put back after
  const env = { ...input.env, [`${input.adapter.toUpperCase()}_FIXTURE_ARGS`]: argsFile }
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  Object.assign(process.env, env)
  try {
    const result = await runMember({
      launch: builtinLaunch(input.adapter),
      product: { id: input.adapter, title: input.adapter, command, args: [] },
      task: { prompt: "做登录", cwd: tmp.path, mode: input.mode ?? "ask", resume: input.resume },
      abort: new AbortController().signal,
      host: {
        step: (step) => {
          steps.push(step)
        },
        permission: async (request) => {
          asked.push(request)
          return input.allow?.(request) === false ? { allow: false, message: "不行" } : { allow: true }
        },
        question: async (list) => {
          questions.push(list)
          return input.answer?.(list) ?? []
        },
      },
    })
    const recorded: unknown = JSON.parse(await fs.readFile(argsFile, "utf8"))
    // The Claude fixture records its arguments; the Codex one its arguments and the JSON-RPC calls it got
    const args = (Array.isArray(recorded) ? recorded : (recorded as { argv: string[] }).argv) as string[]
    const calls = (Array.isArray(recorded) ? {} : recorded) as Record<string, any>
    return { result, asked, questions, steps, args, calls, cwd: tmp.path }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test("Claude Code asks MerakCode before it fetches a page, and is told the answer", async () => {
  const tools = [{ name: "WebFetch", input: { url: "https://example.com/docs", prompt: "title" } }]
  const allowed = await run({ adapter: "claude", env: { CLAUDE_FIXTURE: JSON.stringify(tools) } })
  expect(allowed.asked).toEqual([{ kind: "network", host: "example.com", url: "https://example.com/docs" }])
  expect(allowed.result.text).toContain("WebFetch allowed")
  expect(allowed.result.sessionId).toBe("claude-session-1")
  expect(allowed.steps).toEqual([{ tool: "WebFetch", detail: "https://example.com/docs" }])

  const denied = await run({ adapter: "claude", env: { CLAUDE_FIXTURE: JSON.stringify(tools) }, allow: () => false })
  expect(denied.result.text).toContain("WebFetch denied: 不行")
}, 60_000)

test("Claude Code gets no edit tools in read-only mode, and the resumed session on its next task", async () => {
  const readonly = await run({ adapter: "claude", mode: "readonly", env: { CLAUDE_FIXTURE: "[]" } })
  expect(readonly.args).toEqual(
    expect.arrayContaining(["--permission-mode", "manual", "--permission-prompt-tool", "stdio"]),
  )
  expect(readonly.args.slice(readonly.args.indexOf("--disallowedTools"))).toEqual(
    expect.arrayContaining(["Edit", "Write", "NotebookEdit"]),
  )
  const resumed = await run({ adapter: "claude", resume: "claude-session-7", env: { CLAUDE_FIXTURE: "[]" } })
  expect(resumed.args).not.toContain("--disallowedTools")
  expect(resumed.args.slice(resumed.args.indexOf("--resume"), resumed.args.indexOf("--resume") + 2)).toEqual([
    "--resume",
    "claude-session-7",
  ])
  expect(resumed.result.sessionId).toBe("claude-session-7")
}, 60_000)

test("Claude Code's edits, commands and reads are asked as such, and its questions become MerakCode questions", async () => {
  const tools = [
    { name: "Edit", input: { file_path: "src/a.ts", old_string: "a", new_string: "b" } },
    { name: "Bash", input: { command: "npm test" } },
    { name: "Read", input: { file_path: ".env" } },
    {
      name: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "用哪个数据库？",
            header: "数据库",
            multiSelect: false,
            options: [
              { label: "PostgreSQL", description: "关系型" },
              { label: "SQLite", description: "嵌入式" },
            ],
          },
        ],
      },
    },
  ]
  const result = await run({
    adapter: "claude",
    env: { CLAUDE_FIXTURE: JSON.stringify(tools) },
    answer: () => [["SQLite"]],
  })
  expect(result.asked).toEqual([
    { kind: "write", paths: ["src/a.ts"] },
    { kind: "command", command: "npm test" },
    { kind: "read", paths: [".env"] },
  ])
  expect(result.questions).toEqual([
    [
      {
        question: "用哪个数据库？",
        header: "数据库",
        multiple: false,
        options: [
          { label: "PostgreSQL", description: "关系型" },
          { label: "SQLite", description: "嵌入式" },
        ],
      },
    ],
  ])
  // Claude Code reads the answer from the tool input, keyed by the question
  expect(result.result.text).toContain('"answers":{"用哪个数据库？":"SQLite"}')
}, 60_000)

test("Codex runs as an app server that asks MerakCode about its commands, file changes and questions", async () => {
  const items = [
    { type: "command", command: "npm test" },
    { type: "fileChange", paths: ["src/a.ts"] },
    { type: "question", question: "用哪个数据库？", options: ["PostgreSQL", "SQLite"] },
  ]
  const result = await run({
    adapter: "codex",
    env: { CODEX_FIXTURE: JSON.stringify(items) },
    allow: (request) => request.kind !== "write",
    answer: () => [["SQLite"]],
  })
  expect(result.args[0]).toBe("app-server")
  expect(result.calls["thread/start"]).toMatchObject({ approvalPolicy: "untrusted", sandbox: "workspace-write" })
  expect(result.asked).toEqual([
    { kind: "command", command: "npm test" },
    { kind: "write", paths: ["src/a.ts"] },
  ])
  expect(result.questions[0]).toEqual([
    {
      question: "用哪个数据库？",
      header: "选择",
      options: [
        { label: "PostgreSQL", description: "" },
        { label: "SQLite", description: "" },
      ],
    },
  ])
  expect(result.result.text).toContain("command accept")
  expect(result.result.text).toContain("fileChange decline")
  expect(result.result.text).toContain('answer {"q1":{"answers":["SQLite"]}}')
  expect(result.result.sessionId).toBe("codex-thread-1")
  expect(result.steps).toEqual([
    { tool: "command", detail: "npm test" },
    { tool: "edit", detail: "src/a.ts" },
  ])
}, 60_000)

test("Codex reads only in read-only mode, and continues its thread on the next task", async () => {
  const readonly = await run({ adapter: "codex", mode: "readonly", env: { CODEX_FIXTURE: "[]" } })
  expect(readonly.calls["thread/start"]).toMatchObject({ sandbox: "read-only" })
  const resumed = await run({ adapter: "codex", resume: "codex-thread-7", env: { CODEX_FIXTURE: "[]" } })
  expect(resumed.calls["thread/resume"]).toMatchObject({ threadId: "codex-thread-7", approvalPolicy: "untrusted" })
  expect(resumed.calls["thread/start"]).toBeUndefined()
  expect(resumed.result.sessionId).toBe("codex-thread-7")
}, 60_000)

test("the shell Codex wraps a command in is taken off before MerakCode judges it", async () => {
  const { unwrapShell } = await import("../../src/agent/external/adapters/codex")
  expect(
    unwrapShell(`"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'node -e "console.log(42)"'`),
  ).toBe(`node -e "console.log(42)"`)
  expect(unwrapShell(`/bin/bash -lc 'rm -rf build && npm test'`)).toBe("rm -rf build && npm test")
  expect(unwrapShell("git status")).toBe("git status")
})

test("OpenCode runs as a local server whose permission requests and questions come to MerakCode", async () => {
  const items = [
    { permission: "edit", patterns: ["src/a.ts"], metadata: { filepath: "src/a.ts" } },
    { permission: "bash", patterns: ["npm test"], metadata: { command: "npm test" } },
    { permission: "webfetch", patterns: ["https://example.com"], metadata: { url: "https://example.com" } },
    { question: "用哪个数据库？", options: ["PostgreSQL", "SQLite"] },
  ]
  const result = await run({
    adapter: "opencode",
    env: { OPENCODE_FIXTURE: JSON.stringify(items) },
    allow: (request) => request.kind !== "network",
    answer: () => [["SQLite"]],
  })
  expect(result.args.slice(0, 3)).toEqual(["serve", "--hostname", "127.0.0.1"])
  // Everything OpenCode would decide itself is asked instead, for MerakCode to decide; only this run sees it
  expect(result.calls.config.permission).toMatchObject({
    edit: "ask",
    bash: "ask",
    webfetch: "ask",
    external_directory: "ask",
  })
  expect(result.asked).toEqual([
    { kind: "write", paths: ["src/a.ts"] },
    { kind: "command", command: "npm test" },
    { kind: "network", host: "example.com", url: "https://example.com" },
  ])
  expect(result.questions[0]![0]).toMatchObject({ question: "用哪个数据库？" })
  expect(result.result.text).toContain("edit once")
  expect(result.result.text).toContain("webfetch reject")
  expect(result.result.text).toContain('answer [["SQLite"]]')
  expect(result.result.sessionId).toBe("ses_fixture_1")
  // One step per tool, however often OpenCode updates it
  expect(result.steps).toEqual([
    { tool: "edit", detail: "src/a.ts" },
    { tool: "bash", detail: "npm test" },
    { tool: "webfetch", detail: "https://example.com" },
  ])
}, 60_000)

test("OpenCode cannot edit in read-only mode, and continues its session on the next task", async () => {
  const readonly = await run({ adapter: "opencode", mode: "readonly", env: { OPENCODE_FIXTURE: "[]" } })
  expect(readonly.calls.config.permission).toMatchObject({ edit: "deny" })
  const resumed = await run({ adapter: "opencode", resume: "ses_old", env: { OPENCODE_FIXTURE: "[]" } })
  expect(resumed.calls.prompts).toEqual([expect.objectContaining({ sessionID: "ses_old" })])
  expect(resumed.result.sessionId).toBe("ses_old")
}, 60_000)

test("OpenCode's server does not outlive the task, though it runs behind a launcher script", async () => {
  await using tmp = await tmpdir()
  const pidFile = path.join(tmp.path, "server.pid")
  await run({ adapter: "opencode", env: { OPENCODE_FIXTURE: "[]", OPENCODE_FIXTURE_PID: pidFile } })
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
}, 60_000)

test("when MerakCode goes away mid-task, the CLI an adapter started is stopped with it", async () => {
  await using tmp = await tmpdir()
  const command = await shim(tmp.path, "opencode", "opencode.ts")
  const pidFile = path.join(tmp.path, "server.pid")
  // The adapter alone, as the engine starts it; closing its stdin is what the engine exiting does
  const { spawn } = await import("node:child_process")
  const adapter = spawn(builtinLaunch("opencode")[0]!, builtinLaunch("opencode").slice(1), {
    cwd: tmp.path,
    env: {
      ...process.env,
      OPENCODE_FIXTURE: JSON.stringify([{ question: "Q?", options: ["A"] }]),
      OPENCODE_FIXTURE_PID: pidFile,
    },
    stdio: ["pipe", "pipe", "inherit"],
  })
  const send = (message: object) => adapter.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n")
  const asked = Promise.withResolvers<void>()
  const lines = readline.createInterface({ input: adapter.stdout, crlfDelay: Infinity })
  lines.on("line", (line) => {
    const message = JSON.parse(line)
    if (message.method === "session.started") send({ id: message.id, result: null })
    if (message.method === "question/ask") asked.resolve()
  })
  send({
    id: 1,
    method: "initialize",
    params: { protocol: 1, product: { id: "opencode", title: "OpenCode", command, args: [] } },
  })
  send({ id: 2, method: "task/run", params: { prompt: "hi", cwd: tmp.path, mode: "ask" } })
  // Wait until the server runs and asks its question, then go away without answering
  await expect
    .poll(
      () =>
        fs.access(pidFile).then(
          () => true,
          () => false,
        ),
      { timeout: 20_000 },
    )
    .toBe(true)
  // Leave while the member's question is still waiting for the user
  await asked.promise
  adapter.stdin.end()
  const pid = Number(await fs.readFile(pidFile, "utf8"))
  const alive = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  await expect.poll(alive, { timeout: 15_000, interval: 200 }).toBe(false)
}, 60_000)

test("when a member's task is done, the adapter it ran is already gone", async () => {
  await using tmp = await tmpdir()
  const marker = path.join(tmp.path, "member")
  const fixture = path.join(import.meta.dirname, "fixture", "adapter.ts")
  await runMember({
    launch: [process.execPath, ...process.execArgv, fixture, JSON.stringify({ marker })],
    product: { id: "fixture", title: "Fixture" },
    task: { prompt: "hi", cwd: tmp.path, mode: "ask" },
    abort: new AbortController().signal,
    host: { step: () => {}, permission: async () => ({ allow: true }), question: async () => [] },
  })
  const pid = Number(await fs.readFile(marker + ".pid", "utf8"))
  // Checked at once: a host that exits right after must not leave it behind
  expect(() => process.kill(pid, 0)).toThrow()
}, 60_000)

test("when MerakCode itself exits mid-task, the CLI of a member at work does not stay behind", async () => {
  await using tmp = await tmpdir()
  const command = await shim(tmp.path, "opencode", "opencode.ts")
  const pidFile = path.join(tmp.path, "server.pid")
  // A host like the engine: it runs a member, and exits while the member's question is still open
  const host = path.join(tmp.path, "host.mts")
  const member = pathToFileURL(path.join(import.meta.dirname, "../../src/agent/external/runtime.ts")).href
  const adapters = pathToFileURL(path.join(import.meta.dirname, "../../src/agent/external/adapters/index.ts")).href
  await fs.writeFile(
    host,
    [
      `import { runMember } from ${JSON.stringify(member)}`,
      `import { builtinLaunch } from ${JSON.stringify(adapters)}`,
      `void runMember({`,
      `  launch: builtinLaunch("opencode"),`,
      `  product: { id: "opencode", title: "OpenCode", command: ${JSON.stringify(command)}, args: [] },`,
      `  task: { prompt: "hi", cwd: ${JSON.stringify(tmp.path)}, mode: "ask" },`,
      `  abort: new AbortController().signal,`,
      `  host: { step: () => {}, permission: async () => ({ allow: true }), question: () => process.exit(0) },`,
      `})`,
    ].join("\n"),
  )
  const { execFile } = await import("node:child_process")
  await new Promise((resolve) =>
    execFile(
      process.execPath,
      [...process.execArgv, host],
      {
        env: {
          ...process.env,
          OPENCODE_FIXTURE: JSON.stringify([{ question: "Q?", options: ["A"] }]),
          OPENCODE_FIXTURE_PID: pidFile,
        },
      },
      resolve,
    ),
  )
  const pid = Number(await fs.readFile(pidFile, "utf8"))
  const alive = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  await expect.poll(alive, { timeout: 15_000, interval: 200 }).toBe(false)
}, 60_000)
