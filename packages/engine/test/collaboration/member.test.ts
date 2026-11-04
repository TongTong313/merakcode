import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { Identifier } from "@merakcode/util/id"
import type { Permission, Verdict } from "@merakcode/sdk/adapter"
import { Bus } from "../../src/infra/bus"
import { Instance } from "../../src/infra/project/instance"
import { Session } from "../../src/agent/session"
import { SessionPlan } from "../../src/agent/session/plan"
import { DelegateTool } from "../../src/app/task/tools/delegate"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/app/config/files/config"
import { Loop } from "../../src/agent/loop/index"
import { PermissionNext } from "../../src/agent/permission/next"
import { Question } from "../../src/agent/session/question"
import type { PermissionLevel } from "../../src/agent/permission/level"
import { create } from "../../src/app/task/collaboration/store"
import { tmpdir, selectPermissionLevel } from "../fixture/fixture"
import { configureConnections } from "../fixture/agent-connections"

const FIXTURE = path.join(import.meta.dirname, "fixture", "adapter.ts")

test("a group member cannot submit its draft as the root official plan", async () => {
  const result = await delegate({
    permissionLevel: "fullTakeover",
    scenario: { planSubmission: { id: "member-plan", content: "# Member draft", expectedRevision: 0 } },
  })
  expect(result.error).toBeInstanceOf(Error)
})

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
  permissionLevel: PermissionLevel.Value
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
  plan?: string
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
        await selectPermissionLevel({ sessionID: session.id, permissionLevel: input.permissionLevel })
        await create(session.id, { leader: { name: "小主" }, seats: [{ name: "小明", product: product.id }] })
        if (input.plan) {
          await SessionPlan.save({ sessionID: session.id, source: "human", content: input.plan, expectedRevision: 0 })
          await SessionPlan.start(session.id)
          await SessionPlan.save({
            sessionID: session.id,
            source: "human",
            content: "LATER_EDITABLE_B",
            expectedRevision: 1,
          })
        }
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
      const replyErrors: unknown[] = []
      const answer = (request: PermissionNext.Request) =>
        void PermissionNext.reply({
          requestID: request.id,
          decisionRevision: request.decisionRevision,
          ...(input.user ?? (() => ({ reply: "once" })))(request),
        }).catch(async (error) => {
          replyErrors.push(error)
          await PermissionNext.reply({ requestID: request.id, reply: "reject", message: "Unsupported approval reply" })
        })
      const waiting: PermissionNext.Request[] = []
      const delegations: PermissionNext.Request[] = []
      const off = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
        if (event.properties.permission === "subagent") {
          delegations.push(event.properties)
          void PermissionNext.reply({ requestID: event.properties.id, reply: "once" })
          return
        }
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
        const ruleset = Loop.buildToolExecutionRuleset({
          agent,
          session: await Session.get(current.id),
          permissionLevel: input.permissionLevel,
        })
        return tool
          .execute(
            { seat: "小明", task: "干活" },
            {
              sessionID: current.id,
              messageID: current.messageID,
              callID: Identifier.ascending("part"),
              agent: "build",
              permissionLevel: input.permissionLevel,
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
        expect(delegations).toHaveLength(input.permissionLevel === "fullTakeover" ? 0 : (input.calls ?? 1))
        // Questions still waiting for an answer once the member is done
        const open = await Question.list()
        if (result instanceof Error)
          return { error: result, output: undefined, verdicts: [], shown, questions, open, calls: [], replyErrors }
        const output = parse(result.output)
        const calls = results.map((item) => (item instanceof Error ? item : (parse(item.output) as Verdict[])))
        // No per-operation approval may add permanent project grants.
        const saved = (await Config.loadProjectMerakCodeFile()).permission
        return { output, verdicts: output as Verdict[], shown, questions, open, calls, saved, replyErrors }
      } finally {
        off()
        unasked()
      }
    },
  })
}

test.each(["complete", "missing", "small"] as const)(
  "a dependent external group member validates %s plan input before dispatch",
  async (kind) => {
    const content = "FIXED_PLAN_A_" + "x".repeat(24000)
    const result = await delegate({
      permissionLevel: "fullTakeover",
      plan: content,
      scenario: {
        echoTask: true,
        planCapability:
          kind === "missing"
            ? undefined
            : {
                fullInput: true,
                contextTokens: kind === "small" ? 6500 : 20000,
                reservedTokens: 0,
                fixedInputTokens: 100,
              },
      },
    })
    if (kind !== "complete") {
      expect(result.error).toBeInstanceOf(Error)
      return
    }
    expect(result.error).toBeUndefined()
    expect(result.output).toMatchObject({ plan: { content, revision: 1 } })
    expect((result.output as { prompt: string }).prompt).toContain(content)
    expect((result.output as { prompt: string }).prompt).not.toContain("LATER_EDITABLE_B")
  },
)

test("a member's request to reach a website is asked in ask mode, and the member gets the user's answer", async () => {
  const allowed = await delegate({
    permissionLevel: "autoApprove",
    permissions: [{ kind: "network", host: "example.com" }],
  })
  expect(allowed.shown.map((request) => request.permission)).toEqual(["network"])
  expect(allowed.verdicts).toEqual([{ allow: true }])

  const refused = await delegate({
    permissionLevel: "autoApprove",
    permissions: [{ kind: "network", host: "example.com" }],
    user: () => ({ reply: "reject", message: "先别联网" }),
  })
  expect(refused.verdicts).toEqual([{ allow: false, message: expect.stringContaining("先别联网") }])
}, 60_000)

/** "Allow for this conversation" as the approval bar sends it: the first grant the request offers */
const forConversation: User = (request) => ({ reply: "session", scope: request.grants?.[0]?.scope })

test("unisolated member pages reject conversation grants for every actual request", async () => {
  const result = await delegate({
    permissionLevel: "autoApprove",
    permissions: [
      { kind: "network", host: "apps.apple.com", url: "https://apps.apple.com/cn/app/1" },
      { kind: "network", host: "apps.apple.com", url: "https://apps.apple.com/cn/app/2" },
      { kind: "network", host: "example.com", url: "https://example.com/" },
    ],
    user: forConversation,
  })
  expect(result.verdicts.map((verdict) => verdict.allow)).toEqual([false, false, false])
  expect(result.replyErrors).toHaveLength(3)
  for (const error of result.replyErrors) expect(error).toMatchObject({ name: "PermissionGrantUnavailableError" })
  for (const request of result.shown) {
    expect(request.sandboxReady).toBe(false)
    expect(request.grants).toEqual([])
  }
  expect(result.shown.map((request) => request.metadata.url)).toEqual([
    "https://apps.apple.com/cn/app/1",
    "https://apps.apple.com/cn/app/2",
    "https://example.com/",
  ])
}, 60_000)

test("unisolated conversation grants are unavailable and once approvals never persist", async () => {
  const page: Permission = { kind: "network", host: "apps.apple.com", url: "https://apps.apple.com/cn/app/1" }
  const conversation = await delegate({
    permissionLevel: "autoApprove",
    permissions: [page],
    user: forConversation,
    calls: 2,
    newGroup: true,
  })
  expect(conversation.calls.map((call) => (Array.isArray(call) ? call.map((verdict) => verdict.allow) : call))).toEqual(
    [[false], [false]],
  )
  expect(conversation.replyErrors).toHaveLength(2)
  expect(conversation.shown).toHaveLength(2)

  const once = await delegate({
    permissionLevel: "autoApprove",
    permissions: [page],
    user: () => ({ reply: "once" }),
    calls: 2,
    newGroup: true,
  })
  expect(once.calls).toEqual([[{ allow: true }], [{ allow: true }]])
  expect(once.shown).toHaveLength(2)
  expect(JSON.stringify(once.saved ?? {})).not.toContain("apps.apple.com")
}, 60_000)

test("allowing once lets only that request go: the same request is asked again", async () => {
  const page: Permission = { kind: "network", host: "example.com", url: "https://example.com/a" }
  const result = await delegate({ permissionLevel: "autoApprove", permissions: [page, page] })
  expect(result.verdicts).toEqual([{ allow: true }, { allow: true }])
  expect(result.shown).toHaveLength(2)
}, 60_000)

test("refusing without a reason still tells the member it was refused", async () => {
  const result = await delegate({
    permissionLevel: "autoApprove",
    permissions: [{ kind: "network", host: "example.com" }],
    user: () => ({ reply: "reject" }),
  })
  expect(result.verdicts).toEqual([{ allow: false, message: expect.any(String) }])
  expect((result.verdicts[0] as { message: string }).message.trim()).not.toBe("")
}, 60_000)

test("a forged conversation reply cannot release parallel unisolated member operations", async () => {
  const pages = [1, 2, 3, 4].map((page): Permission => ({
    kind: "network",
    host: "apps.apple.com",
    url: `https://apps.apple.com/cn/app/${page}`,
  }))
  const result = await delegate({
    permissionLevel: "autoApprove",
    permissions: pages,
    scenario: { parallel: true },
    user: forConversation,
    gather: 4,
  })
  // A forged scope cannot release the other pending unisolated operations.
  expect(result.shown).toHaveLength(4)
  expect(result.verdicts.map((verdict) => verdict.allow)).toEqual(pages.map(() => false))
  expect(result.replyErrors).toHaveLength(1)
  expect(result.replyErrors[0]).toMatchObject({ name: "PermissionGrantUnavailableError" })
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

  for (const permissionLevel of ["ask", "autoApprove"] as const) {
    const result = await delegate({ permissionLevel, permissions })
    expect(allowed(result)).toEqual(permissions.map(() => true))
    expect(result.shown.map((request) => request.permission)).toEqual([
      "edit",
      "bash",
      "read",
      "bash",
      "mcp__github__create_issue",
      "network",
      "network",
    ])
    for (const request of result.shown) {
      expect(request.sandboxReady).toBe(false)
      expect(request.grants).toEqual([])
    }
  }
  const full = await delegate({ permissionLevel: "fullTakeover", permissions })
  expect(full.shown).toEqual([])
  expect(allowed(full)).toEqual(permissions.map(() => true))
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
  for (const mode of ["ask", "autoApprove", "fullTakeover"] as const) {
    const result = await delegate({ permissionLevel: mode, permissions })
    expect(
      result.verdicts.map((verdict) => verdict.allow),
      mode,
    ).toEqual(permissions.map(() => false))
    expect(result.shown, mode).toEqual([])
    expect(result.verdicts[0]).toMatchObject({ message: expect.stringContaining("names no file") })
  }
}, 120_000)

test("unisolated command prefix grants cannot authorize later member commands", async () => {
  const result = await delegate({
    permissionLevel: "autoApprove",
    permissions: [
      { kind: "command", command: "npm install lodash" },
      { kind: "command", command: "npm install zod" },
    ],
    user: () => ({ reply: "session", scope: "prefix" }),
  })
  expect(result.verdicts.map((verdict) => verdict.allow)).toEqual([false, false])
  expect(result.replyErrors).toHaveLength(2)
  for (const error of result.replyErrors) expect(error).toMatchObject({ name: "PermissionGrantUnavailableError" })
  expect(result.shown).toHaveLength(2)
}, 60_000)

test("a member's question is asked in MerakCode, tied to the member's call, and the answer goes back to it", async () => {
  const result = await delegate({
    permissionLevel: "autoApprove",
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
    permissionLevel: "autoApprove",
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

test("a partially controlled Claude Code member cannot run under auto approval", async () => {
  await using bin = await tmpdir()
  const command = await shim(bin.path, "claude", "claude.ts")
  const saved = process.env.CLAUDE_FIXTURE
  process.env.CLAUDE_FIXTURE = JSON.stringify([{ name: "WebFetch", input: { url: "https://example.com" } }])
  try {
    const result = await delegate({
      permissionLevel: "autoApprove",
      product: { id: "claude", config: { command } },
      user: () => ({ reply: "reject", message: "先别联网" }),
    })
    expect(result.shown).toEqual([])
    expect(result.error?.message).toMatch(/cannot intercept|不能拦截/)
    expect(result.output).toBeUndefined()
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_FIXTURE
    else process.env.CLAUDE_FIXTURE = saved
  }
}, 60_000)

test("a member that ends with no reply fails with the product named, rather than reporting an empty result", async () => {
  const result = await delegate({ permissionLevel: "autoApprove", scenario: { reply: "" } })
  expect(result.error?.message).toMatch(/^MRK-4009: Fixture (?:未返回正文|returned no reply)$/)
}, 60_000)

for (const name of ["codex", "opencode"] as const) {
  test(`the partially controlled ${name} member cannot run under auto approval`, async () => {
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
      const result = await delegate({ permissionLevel: "autoApprove", product: { id: name, config: { command } } })
      expect(result.shown).toEqual([])
      expect(result.error?.message).toMatch(/cannot intercept|不能拦截/)
      expect(result.output).toBeUndefined()
    } finally {
      if (saved === undefined) delete process.env[fixture]
      else process.env[fixture] = saved
    }
  }, 60_000)
}

test("unisolated member edits never offer directory grants or permanent grants", async () => {
  const result = await delegate({
    permissionLevel: "autoApprove",
    // Paths under a folder starting with a dot ask in ask mode, as they do for MerakCode's own edits
    permissions: [
      { kind: "write", paths: [".config/a.json"] },
      { kind: "write", paths: [".config/b.json"] },
      { kind: "write", paths: [".github/c.yml"] },
    ],
    user: () => ({ reply: "session", scope: "directory" }),
  })
  expect(result.verdicts.map((verdict) => verdict.allow)).toEqual([false, false, false])
  expect(result.replyErrors).toHaveLength(3)
  for (const request of result.shown) {
    expect(request.grants).toEqual([])
    expect(request.always).toBe(false)
  }
  expect(result.shown.map((request) => request.patterns[0]?.split("/").slice(-2).join("/"))).toEqual([
    ".config/a.json",
    ".config/b.json",
    ".github/c.yml",
  ])
}, 60_000)

test("unisolated repeated file requests cannot reuse a conversation grant", async () => {
  const result = await delegate({
    permissionLevel: "autoApprove",
    permissions: [
      { kind: "write", paths: [".config/a.json"] },
      { kind: "write", paths: [".config/a.json"] },
      { kind: "write", paths: [".config/b.json"] },
    ],
    user: () => ({ reply: "session", scope: "file" }),
  })
  expect(result.verdicts.map((verdict) => verdict.allow)).toEqual([false, false, false])
  expect(result.replyErrors).toHaveLength(3)
  expect(result.shown.map((request) => request.patterns[0]?.split("/").slice(-2).join("/"))).toEqual([
    ".config/a.json",
    ".config/a.json",
    ".config/b.json",
  ])
}, 60_000)

test("once approval for a member command never creates a persistent allow rule", async () => {
  const result = await delegate({
    permissionLevel: "autoApprove",
    permissions: [{ kind: "command", command: "npm install lodash" }],
    user: () => ({ reply: "once", scope: "prefix" }),
    calls: 2,
  })
  expect(result.calls).toEqual([[{ allow: true }], [{ allow: true }]])
  expect(result.shown).toHaveLength(2)
  expect(JSON.stringify(result.saved ?? {})).not.toContain("npm install *")
}, 60_000)

test("full takeover preserves a member business question and its human answer", async () => {
  const result = await delegate({
    permissionLevel: "fullTakeover",
    questions: [{ question: "Choose?", header: "Choice", options: [{ label: "A", description: "" }] }],
    answer: () => [["A"]],
  })
  expect(result.questions).toHaveLength(1)
  expect(result.open).toEqual([])
  expect(result.error).toBeUndefined()
  expect(result.output).toEqual([["A"]])
}, 60000)
