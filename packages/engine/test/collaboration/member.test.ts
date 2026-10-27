import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { Identifier } from "@merakcode/util/id"
import type { Permission, Verdict } from "@merakcode/sdk/adapter"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { DelegateTool } from "../../src/tool/delegate"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { SessionRunner } from "../../src/session/runner"
import { PermissionNext } from "../../src/permission/next"
import { Question } from "../../src/question"
import type { PermissionMode } from "../../src/permission/mode"
import { create } from "../../src/collaboration/store"
import { tmpdir } from "../fixture/fixture"
import { configureConnections } from "../fixture/agent-connections"

const FIXTURE = path.join(import.meta.dirname, "fixture", "adapter.ts")

/** A user message and the leader's reply to it; returns the reply's id, which a tool call belongs to */
async function turn(sessionID: string, directory: string) {
  const user = await Session.updateInfo({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID,
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-4" },
    time: { created: Date.now() },
  })
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

type User = (request: PermissionNext.Request) => Omit<PermissionNext.ReplyInput, "requestID">

/**
 * A group whose one member runs the fixture adapter with these requests, delegated once in mode. user answers each
 * approval the way a person would; the result is the member's verdicts and the approvals that were shown.
 */
async function delegate(input: {
  mode: PermissionMode.Value
  permissions?: Permission[]
  questions?: Question.Info[]
  user?: User
  /** Answers a question the way a person would; without it questions stay open */
  answer?: (request: Question.Request) => Question.Answer[]
  /** Stops the group once the member has asked its first question */
  stopOnQuestion?: boolean
  /** More of the fixture's scenario */
  scenario?: Record<string, unknown>
  /** The member's product instead of the fixture adapter, with what to put in its config entry */
  product?: { id: string; config: Record<string, unknown> }
  /** How many times the member is given the task, one tool call each (default once) */
  calls?: number
  /** Waits until this many approvals are open, as in the approval bar, and answers only the first */
  gather?: number
  /** Gives each task after the first in a new group of the same project, as a new conversation */
  newGroup?: boolean
}) {
  const scenario = JSON.stringify({ permissions: input.permissions, questions: input.questions, ...input.scenario })
  const product = input.product ?? {
    id: "fixture",
    config: {
      title: "Fixture",
      adapter: "member",
      command: process.execPath,
      args: [...process.execArgv, FIXTURE, scenario],
    },
  }
  await using tmp = await tmpdir({ git: true })
  await configureConnections({ [product.id]: product.config })
  return await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const group = async () => {
        const session = await Session.create({ metadata: { group: true } })
        await create(session.id, { leader: { name: "小主" }, seats: [{ name: "小明", product: product.id }] })
        return { id: session.id, messageID: await turn(session.id, tmp.path) }
      }
      let current = await group()
      const shown: PermissionNext.Request[] = []
      const questions: Question.Request[] = []
      const stop = new AbortController()
      const unasked = Bus.subscribe(Question.Event.Asked, (event) => {
        questions.push(event.properties)
        if (input.stopOnQuestion) setTimeout(() => stop.abort(), 100)
        if (input.answer)
          void Question.reply({ requestID: event.properties.id, answers: input.answer(event.properties) })
      })
      const answer = (request: PermissionNext.Request) =>
        void PermissionNext.reply({ requestID: request.id, ...(input.user ?? (() => ({ reply: "once" })))(request) })
      const waiting: PermissionNext.Request[] = []
      const off = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
        shown.push(event.properties)
        if (!input.gather) return answer(event.properties)
        waiting.push(event.properties)
        if (waiting.length < input.gather) return
        answer(waiting[0]!)
        // The others should have been answered by that; any still open is refused, so the test fails instead of hanging
        setTimeout(() => {
          for (const request of waiting.slice(1))
            void PermissionNext.reply({ requestID: request.id, reply: "reject", message: "still asked" })
        }, 1_000)
      })
      /** One delegate call, with the rules the runner builds for a tool call: mode, config and the group's grants */
      const call = async () => {
        const tool = await DelegateTool.init()
        const agent = (await Agent.get("build"))!
        const ruleset = SessionRunner.buildToolExecutionRuleset({
          agent,
          session: await Session.get(current.id),
          permissionMode: input.mode,
        })
        return tool
          .execute(
            { seat: "小明", task: "干活" },
            {
              sessionID: current.id,
              messageID: current.messageID,
              callID: Identifier.ascending("part"),
              agent: "build",
              permissionMode: input.mode,
              abort: stop.signal,
              messages: [],
              ruleset,
              metadata: () => {},
              ask: (request) => PermissionNext.ask({ ...request, sessionID: current.id, ruleset }),
            },
          )
          .catch((error: Error) => error)
      }
      const parse = (text: string): unknown => {
        try {
          return JSON.parse(text)
        } catch {
          return text
        }
      }
      try {
        const results = []
        for (let index = 0; index < (input.calls ?? 1); index++) {
          if (index > 0 && input.newGroup) current = await group()
          results.push(await call())
        }
        const result = results.at(-1)!
        // Questions still waiting for an answer once the member is done
        const open = await Question.list()
        if (result instanceof Error)
          return { error: result, output: undefined, verdicts: [], shown, questions, open, calls: [] }
        const output = parse(result.output)
        const calls = results.map((item) => (item instanceof Error ? item : (parse(item.output) as Verdict[])))
        // What "always allow" wrote to the project config
        const saved = (await Config.loadProjectMerakCodeFile()).permission
        return { output, verdicts: output as Verdict[], shown, questions, open, calls, saved }
      } finally {
        off()
        unasked()
      }
    },
  })
}

test("a member's request to reach a website is asked in ask mode, and the member gets the user's answer", async () => {
  const allowed = await delegate({ mode: "ask", permissions: [{ kind: "network", host: "example.com" }] })
  expect(allowed.shown.map((request) => request.permission)).toEqual(["network"])
  expect(allowed.verdicts).toEqual([{ allow: true }])

  const refused = await delegate({
    mode: "ask",
    permissions: [{ kind: "network", host: "example.com" }],
    user: () => ({ reply: "reject", message: "先别联网" }),
  })
  expect(refused.verdicts).toEqual([{ allow: false, message: expect.stringContaining("先别联网") }])
}, 60_000)

/** "Allow for this conversation" as the approval bar sends it: the first grant the request offers */
const forConversation: User = (request) => ({ reply: "session", scope: request.grants?.[0]?.scope })

test("allowing a website for the conversation covers the member's later pages of it, and not other websites", async () => {
  const result = await delegate({
    mode: "ask",
    permissions: [
      { kind: "network", host: "apps.apple.com", url: "https://apps.apple.com/cn/app/1" },
      { kind: "network", host: "apps.apple.com", url: "https://apps.apple.com/cn/app/2" },
      { kind: "network", host: "example.com", url: "https://example.com/" },
    ],
    user: forConversation,
  })
  expect(result.verdicts).toEqual([{ allow: true }, { allow: true }, { allow: true }])
  // The choice names the website, as in the approval bar
  expect(result.shown[0]!.grants?.[0]?.pattern).toContain("apps.apple.com")
  expect(result.shown.map((request) => request.metadata.url)).toEqual([
    "https://apps.apple.com/cn/app/1",
    "https://example.com/",
  ])
}, 60_000)

test("allowing for the conversation stays in it, while always allowing also covers a new conversation", async () => {
  const page: Permission = { kind: "network", host: "apps.apple.com", url: "https://apps.apple.com/cn/app/1" }
  const conversation = await delegate({
    mode: "ask",
    permissions: [page],
    user: forConversation,
    calls: 2,
    newGroup: true,
  })
  expect(conversation.calls).toEqual([[{ allow: true }], [{ allow: true }]])
  expect(conversation.shown).toHaveLength(2)

  const always = await delegate({
    mode: "ask",
    permissions: [page],
    user: () => ({ reply: "always" }),
    calls: 2,
    newGroup: true,
  })
  expect(always.calls).toEqual([[{ allow: true }], [{ allow: true }]])
  expect(always.shown).toHaveLength(1)
  expect(JSON.stringify(always.saved)).toContain("apps.apple.com")
}, 60_000)

test("allowing once lets only that request go: the same request is asked again", async () => {
  const page: Permission = { kind: "network", host: "example.com", url: "https://example.com/a" }
  const result = await delegate({ mode: "ask", permissions: [page, page] })
  expect(result.verdicts).toEqual([{ allow: true }, { allow: true }])
  expect(result.shown).toHaveLength(2)
}, 60_000)

test("refusing without a reason still tells the member it was refused", async () => {
  const result = await delegate({
    mode: "ask",
    permissions: [{ kind: "network", host: "example.com" }],
    user: () => ({ reply: "reject" }),
  })
  expect(result.verdicts).toEqual([{ allow: false, message: expect.any(String) }])
  expect((result.verdicts[0] as { message: string }).message.trim()).not.toBe("")
}, 60_000)

test("requests a member makes at once wait together, and allowing the website for the conversation lets them all go", async () => {
  const pages = [1, 2, 3, 4].map((page): Permission => ({
    kind: "network",
    host: "apps.apple.com",
    url: `https://apps.apple.com/cn/app/${page}`,
  }))
  const result = await delegate({
    mode: "ask",
    permissions: pages,
    scenario: { parallel: true },
    user: forConversation,
    gather: 4,
  })
  // All four were in the approval bar ("3 more waiting"); one answer let them all go
  expect(result.shown).toHaveLength(4)
  expect(result.verdicts).toEqual(pages.map(() => ({ allow: true })))
}, 60_000)

test("each kind of request is judged like MerakCode's own tools, in each permission mode", async () => {
  const permissions: Permission[] = [
    { kind: "write", paths: ["src/a.ts"] },
    { kind: "command", command: "rm -rf build" },
    { kind: "read", paths: [".env"] },
    { kind: "command", command: "git status" },
    { kind: "tool", name: "mcp__github__create_issue" },
    { kind: "network", host: "example.com" },
    { kind: "network", host: "registry.npmjs.org" },
  ]
  const allowed = (result: Awaited<ReturnType<typeof delegate>>) => result.verdicts.map((verdict) => verdict.allow)

  // Read-only: no edits and no commands that change files; reading a secret, other tools and websites ask
  const readonly = await delegate({ mode: "readonly", permissions })
  expect(allowed(readonly)).toEqual([false, false, true, true, true, true, true])
  expect(readonly.shown.map((request) => request.permission)).toEqual(["read", "mcp__github__create_issue", "network"])

  // Ask: edits in the workspace go ahead; deleting, a secret, other tools and websites ask
  const ask = await delegate({ mode: "ask", permissions })
  expect(allowed(ask)).toEqual([true, true, true, true, true, true, true])
  expect(ask.shown.map((request) => request.permission)).toEqual([
    "bash",
    "read",
    "mcp__github__create_issue",
    "network",
  ])

  // Auto: only the secret and websites ask
  const auto = await delegate({ mode: "auto", permissions })
  expect(auto.shown.map((request) => request.permission)).toEqual(["read", "network"])
  // In every mode a website on the allowlist (package registries, code hosting) is not asked about
  for (const result of [readonly, ask, auto])
    expect(result.shown.some((request) => request.patterns.includes("registry.npmjs.org"))).toBe(false)
}, 120_000)

test("a request with nothing to check (no file, an empty command) is refused without asking, in every mode", async () => {
  const permissions: Permission[] = [
    { kind: "write", paths: [] },
    { kind: "write", paths: [""] },
    { kind: "read", paths: [] },
    { kind: "command", command: "" },
    { kind: "command", command: "   " },
    { kind: "network", host: "" },
    { kind: "tool", name: "" },
  ]
  for (const mode of ["readonly", "ask", "auto"] as const) {
    const result = await delegate({ mode, permissions })
    expect(
      result.verdicts.map((verdict) => verdict.allow),
      mode,
    ).toEqual(permissions.map(() => false))
    expect(result.shown, mode).toEqual([])
    expect(result.verdicts[0]).toMatchObject({ message: expect.stringContaining("names no file") })
  }
}, 120_000)

test("allowing a command for the conversation covers the member's later commands of the same kind", async () => {
  const result = await delegate({
    mode: "ask",
    permissions: [
      { kind: "command", command: "npm install lodash" },
      { kind: "command", command: "npm install zod" },
    ],
    user: () => ({ reply: "session", scope: "prefix" }),
  })
  expect(result.verdicts).toEqual([{ allow: true }, { allow: true }])
  expect(result.shown).toHaveLength(1)
}, 60_000)

test("a member's question is asked in MerakCode, tied to the member's call, and the answer goes back to it", async () => {
  const result = await delegate({
    mode: "ask",
    questions: [
      {
        question: "用哪个数据库？",
        header: "数据库",
        options: [
          { label: "PostgreSQL", description: "关系型" },
          { label: "SQLite", description: "嵌入式" },
        ],
      },
    ],
    answer: () => [["SQLite"]],
  })
  expect(result.questions).toHaveLength(1)
  expect(result.questions[0]!.questions[0]!.question).toBe("用哪个数据库？")
  expect(result.questions[0]!.tool?.callID).toBeTruthy()
  expect(result.output).toEqual([["SQLite"]])
}, 60_000)

test("stopping the group withdraws the member's open question, tells the adapter to stop, and ends one that keeps on", async () => {
  await using tmp = await tmpdir()
  const marker = path.join(tmp.path, "cancelled")
  const started = Date.now()
  const result = await delegate({
    mode: "ask",
    questions: [{ question: "继续吗？", header: "继续", options: [{ label: "是", description: "" }] }],
    stopOnQuestion: true,
    scenario: { marker, ignore: true },
  })
  expect(result.error).toBeInstanceOf(Error)
  expect(result.questions).toHaveLength(1)
  expect(result.open).toEqual([])
  // Telling the adapter to stop reaches it a moment after the group stops
  await expect.poll(() => fs.readFile(marker, "utf8").catch(() => ""), { timeout: 10_000 }).toBe("cancelled")
  // An adapter that ignores the stop is ended after a grace period, not left running
  const pid = Number(await fs.readFile(marker + ".pid", "utf8"))
  const alive = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  expect(pid).toBeGreaterThan(0)
  await expect.poll(alive, { timeout: 15_000, interval: 200 }).toBe(false)
  expect(Date.now() - started).toBeLessThan(20_000)
}, 60_000)

/** A command on disk named name that runs a TypeScript fixture with this process's loader */
async function shim(dir: string, name: string, fixture: string) {
  const script = path.join(import.meta.dirname, "fixture", fixture)
  const flags = process.execArgv.map((arg) => `"${arg}"`).join(" ")
  const command = process.platform === "win32" ? path.join(dir, `${name}.cmd`) : path.join(dir, name)
  await fs.writeFile(
    command,
    process.platform === "win32"
      ? `@"${process.execPath}" ${flags} "${script}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" ${flags} "${script}" "$@"\n`,
    { mode: 0o755 },
  )
  return command
}

test("the built-in Claude Code member asks MerakCode before it fetches a page", async () => {
  await using bin = await tmpdir()
  const command = await shim(bin.path, "claude", "claude.ts")
  const saved = process.env.CLAUDE_FIXTURE
  process.env.CLAUDE_FIXTURE = JSON.stringify([{ name: "WebFetch", input: { url: "https://example.com" } }])
  try {
    const result = await delegate({
      mode: "ask",
      product: { id: "claude", config: { command } },
      user: () => ({ reply: "reject", message: "先别联网" }),
    })
    expect(result.shown.map((request) => request.permission)).toEqual(["network"])
    expect(result.output).toContain("WebFetch denied")
    expect(result.output).toContain("先别联网")
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_FIXTURE
    else process.env.CLAUDE_FIXTURE = saved
  }
}, 60_000)

test("a member that ends with no reply fails with the product named, rather than reporting an empty result", async () => {
  const result = await delegate({ mode: "ask", scenario: { reply: "" } })
  expect(result.error?.message).toMatch(/^MRK-4009: Fixture (?:未返回正文|returned no reply)$/)
}, 60_000)

for (const name of ["codex", "opencode"] as const) {
  test(`the built-in ${name} member asks MerakCode before it runs a command`, async () => {
    await using bin = await tmpdir()
    const command = await shim(bin.path, name, `${name}.ts`)
    const fixture = `${name.toUpperCase()}_FIXTURE`
    const saved = process.env[fixture]
    process.env[fixture] = JSON.stringify(
      name === "codex"
        ? [{ type: "command", command: "rm -rf build" }]
        : [{ permission: "bash", patterns: ["rm -rf build"], metadata: { command: "rm -rf build" } }],
    )
    try {
      const result = await delegate({ mode: "ask", product: { id: name, config: { command } } })
      expect(result.shown.map((request) => request.permission)).toEqual(["bash"])
      expect(result.error).toBeUndefined()
    } finally {
      if (saved === undefined) delete process.env[fixture]
      else process.env[fixture] = saved
    }
  }, 60_000)
}

test("a member's edit offers the same choices as MerakCode's own, and trusting a directory covers its other files", async () => {
  const result = await delegate({
    mode: "ask",
    // Paths under a folder starting with a dot ask in ask mode, as they do for MerakCode's own edits
    permissions: [
      { kind: "write", paths: [".config/a.json"] },
      { kind: "write", paths: [".config/b.json"] },
      { kind: "write", paths: [".github/c.yml"] },
    ],
    user: () => ({ reply: "session", scope: "directory" }),
  })
  expect(result.verdicts).toEqual([{ allow: true }, { allow: true }, { allow: true }])
  // The file and its directory can each be trusted for the conversation, and always allowed, as for the edit tool
  expect((result.shown[0]!.grants ?? []).map((grant) => grant.scope)).toEqual(["file", "directory"])
  expect(result.shown[0]!.always).toBe(true)
  // Trusting .config covered b.json; .github is another directory and asked again
  expect(result.shown.map((request) => request.patterns[0]?.split("/").slice(-2).join("/"))).toEqual([
    ".config/a.json",
    ".github/c.yml",
  ])
}, 60_000)

test("trusting a file for the conversation covers that file again, and not the others in its directory", async () => {
  const result = await delegate({
    mode: "ask",
    permissions: [
      { kind: "write", paths: [".config/a.json"] },
      { kind: "write", paths: [".config/a.json"] },
      { kind: "write", paths: [".config/b.json"] },
    ],
    user: () => ({ reply: "session", scope: "file" }),
  })
  expect(result.verdicts).toEqual([{ allow: true }, { allow: true }, { allow: true }])
  expect(result.shown.map((request) => request.patterns[0]?.split("/").slice(-2).join("/"))).toEqual([
    ".config/a.json",
    ".config/b.json",
  ])
}, 60_000)

test("always allowing a member's command saves the rule to the project, so its next task is not asked again", async () => {
  const result = await delegate({
    mode: "ask",
    permissions: [{ kind: "command", command: "npm install lodash" }],
    user: () => ({ reply: "always", scope: "prefix" }),
    calls: 2,
  })
  expect(result.calls).toEqual([[{ allow: true }], [{ allow: true }]])
  expect(result.shown).toHaveLength(1)
  expect(JSON.stringify(result.saved)).toContain("npm install *")
}, 60_000)
