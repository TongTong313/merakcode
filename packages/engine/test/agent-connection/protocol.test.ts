import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { runMember, discoverModels, inspectMember } from "../../src/agent-connection/runtime"
import { tmpdir } from "../fixture/fixture"
import { builtinLaunch } from "../../src/agent-connection/adapters"
import { shim } from "../collaboration/fixture/shim"
import type { ProductModel } from "@merakcode/sdk/adapter"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { pathToFileURL } from "node:url"

async function runBuiltin(
  adapter: "claude" | "codex" | "opencode",
  model: ProductModel,
  resume?: string,
  extra: Record<string, string> = {},
) {
  await using tmp = await tmpdir()
  const command = await shim(tmp.path, adapter, `${adapter}.ts`)
  const file = path.join(tmp.path, "args.json")
  const values = {
    ...extra,
    [`${adapter.toUpperCase()}_FIXTURE_STREAM`]: "true",
    [`${adapter.toUpperCase()}_FIXTURE_ARGS`]: file,
  }
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  Object.assign(process.env, values)
  const deltas: string[] = []
  let sessionID: string | undefined
  try {
    const result = await runMember({
      launch: builtinLaunch(adapter),
      product: { id: adapter, title: adapter, command, args: [] },
      task: { prompt: "Hello world", cwd: tmp.path, mode: "ask", model, resume },
      abort: new AbortController().signal,
      host: {
        step: () => {},
        permission: async () => ({ allow: true }),
        question: async () => [],
        sessionStarted: async (input) => {
          sessionID = input.sessionId
        },
        textDelta: (input) => {
          expect(sessionID).toBeDefined()
          deltas.push(input.delta)
        },
      },
    })
    return { result, deltas, recorded: JSON.parse(await fs.readFile(file, "utf8")) }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test("selects an explicit Claude model and streams only its final text once", async () => {
  const { result, deltas, recorded } = await runBuiltin("claude", { id: "fixture-explicit" }, "claude-old")
  expect(recorded).toEqual(
    expect.arrayContaining(["--model", "fixture-explicit", "--resume", "claude-old", "--include-partial-messages"]),
  )
  expect(deltas.join("")).toBe("Hello world")
  expect(result).toMatchObject({
    text: "Hello world",
    sessionId: "claude-old",
    actualModel: { id: "fixture-explicit" },
  })
}, 30_000)

test("rejects a Claude result whose subtype is success but is_error is true", async () => {
  await expect(
    runBuiltin("claude", { id: "fixture-explicit" }, undefined, { CLAUDE_FIXTURE_ERROR: "true" }),
  ).rejects.toThrow("Hello world")
}, 30_000)

test("selects a Codex model on the resumed thread and turn and streams text", async () => {
  const { result, deltas, recorded } = await runBuiltin("codex", { id: "fixture-explicit" }, "thread-old")
  expect(recorded["thread/resume"]).toMatchObject({ threadId: "thread-old", model: "fixture-explicit" })
  expect(recorded["turn/start"]).toMatchObject({ threadId: "thread-old", model: "fixture-explicit" })
  expect(deltas.join("")).toBe("Hello world")
  expect(result).toMatchObject({
    text: "Hello world",
    sessionId: "thread-old",
    actualModel: { id: "fixture-explicit" },
  })
}, 30_000)

test("sends an OpenCode provider model in the prompt body and streams assistant text", async () => {
  const { result, deltas, recorded } = await runBuiltin(
    "opencode",
    { id: "fixture-explicit", providerID: "fixture-provider" },
    "session-old",
  )
  expect(recorded.prompts[0]).toMatchObject({
    sessionID: "session-old",
    model: { providerID: "fixture-provider", modelID: "fixture-explicit" },
  })
  expect(recorded.argv).not.toContain("--model")
  expect(deltas.join("")).toBe("Hello world")
  expect(result).toMatchObject({
    text: "Hello world",
    sessionId: "session-old",
    actualModel: { id: "fixture-explicit", providerID: "fixture-provider" },
  })
}, 30_000)

test("discovers Claude aliases without running a model task", async () => {
  await using tmp = await tmpdir()
  const command = await shim(tmp.path, "claude", "claude.ts")
  const result = await discoverModels({
    launch: builtinLaunch("claude"),
    product: { id: "claude", title: "Claude", command },
    cwd: tmp.path,
  })
  expect(result).toMatchObject({ allowCustomID: true })
  expect(result.models.map((model) => model.id)).toEqual(["sonnet", "opus", "haiku"])
}, 30_000)

test("discovers Codex models from the app server catalog", async () => {
  await using tmp = await tmpdir()
  const command = await shim(tmp.path, "codex", "codex.ts")
  const result = await discoverModels({
    launch: builtinLaunch("codex"),
    product: { id: "codex", title: "Codex", command },
    cwd: tmp.path,
  })
  expect(result).toEqual({ models: [{ id: "fixture-model", title: "Fixture model" }], allowCustomID: true })
}, 30_000)

test("discovers OpenCode models with their provider identity", async () => {
  await using tmp = await tmpdir()
  const command = await shim(tmp.path, "opencode", "opencode.ts")
  const result = await discoverModels({
    launch: builtinLaunch("opencode"),
    product: { id: "opencode", title: "OpenCode", command },
    cwd: tmp.path,
  })
  expect(result).toEqual({
    models: [{ id: "fixture-model", providerID: "fixture-provider", title: "Fixture model" }],
    allowCustomID: true,
  })
}, 30_000)

test("passes a command model through argv without advertising streamed text", async () => {
  await using tmp = await tmpdir()
  const launch = builtinLaunch("command")
  const product = {
    id: "command",
    title: "Command",
    command: process.execPath,
    args: ["-e", "process.stdout.write(process.argv[1])", "{model}"],
  }
  const info = await inspectMember({ launch, product, cwd: tmp.path })
  expect(info.capabilities?.textStreaming).toBe(false)
  const deltas: string[] = []
  const result = await runMember({
    launch,
    product,
    task: { prompt: "", cwd: tmp.path, mode: "ask", model: { id: "fixture-model" } },
    abort: new AbortController().signal,
    host: {
      step: () => {},
      permission: async () => ({ allow: true }),
      question: async () => [],
      textDelta: (input) => {
        deltas.push(input.delta)
      },
    },
  })
  expect(result.text).toBe("fixture-model")
  expect(result.actualModel).toBeUndefined()
  expect(deltas).toEqual([])
}, 30_000)

test.each([
  ["\n", false],
  ["\r\n", false],
  ["", false],
  ["\n", true],
  ["\r\n", true],
])("saves a complete command session line across output chunks (ending: %j, stop: %s)", async (ending, stop) => {
  await using tmp = await tmpdir()
  const ready = path.join(tmp.path, "partial-ready")
  const gate = path.join(tmp.path, "release-suffix")
  const file = path.join(tmp.path, "split-session.mjs")
  await fs.writeFile(
    file,
    `import fs from "node:fs/promises"
import { setTimeout } from "node:timers/promises"
await new Promise((resolve) => process.stdout.write("SESSION_ID: thread-", resolve))
await fs.writeFile(process.argv[2], "ready")
while (!(await fs.access(process.argv[3]).then(() => true, () => false))) await setTimeout(10)
process.stdout.write(${JSON.stringify("123456" + ending)})
process.exitCode = 7
`,
  )
  const sessionIDs: string[] = []
  const controller = new AbortController()
  const result = runMember({
    launch: builtinLaunch("command"),
    product: {
      id: "split-command",
      title: "Split command",
      command: process.execPath,
      args: [file, ready, gate],
      resumeArgs: [file, "{id}"],
      sessionLine: "^SESSION_ID: ([A-Za-z0-9-]+)$",
    },
    task: { prompt: "synthetic task", cwd: tmp.path, mode: "ask" },
    abort: controller.signal,
    host: {
      step: () => {},
      permission: async () => ({ allow: false, message: "Unused by this command" }),
      question: async () => [],
      sessionStarted: async ({ sessionId }) => {
        sessionIDs.push(sessionId)
        if (stop) controller.abort()
      },
    },
  })
  void result.catch(() => {})
  try {
    await expect
      .poll(
        () =>
          fs.access(ready).then(
            () => true,
            () => false,
          ),
        { timeout: 5000 },
      )
      .toBe(true)
    await fs.writeFile(gate, "release")
    await expect(result).rejects.toThrow(stop ? "外部任务已停止" : "exit code 7")
    expect(sessionIDs).toEqual(["thread-123456"])
  } finally {
    controller.abort()
    await fs.writeFile(gate, "release")
    await result.catch(() => {})
  }
})

test("rejects an invalid adapter result instead of treating it as a successful reply", async () => {
  await using tmp = await tmpdir()
  await expect(
    runMember({
      launch: [
        process.execPath,
        ...process.execArgv,
        path.join(import.meta.dirname, "adapter-fixture.ts"),
        "malformed",
      ],
      product: { id: "fixture", title: "Fixture" },
      task: { prompt: "", cwd: tmp.path, mode: "ask" },
      abort: new AbortController().signal,
      host: { step: () => {}, permission: async () => ({ allow: true }), question: async () => [] },
    }),
  ).rejects.toThrow("适配器返回的结果格式无效")
}, 30_000)

test("keeps the host alive after model discovery returns an unsupported capability", async () => {
  await using tmp = await tmpdir()
  const script = path.join(tmp.path, "host.mts")
  const runtime = pathToFileURL(path.join(import.meta.dirname, "../../src/agent-connection/runtime.ts")).href
  const fixture = path.join(import.meta.dirname, "adapter-fixture.ts")
  await fs.writeFile(
    script,
    [
      `import { discoverModels } from ${JSON.stringify(runtime)}`,
      `await discoverModels({ launch: ${JSON.stringify([process.execPath, ...process.execArgv, fixture])}, product: { id: "fixture", title: "Fixture" }, cwd: ${JSON.stringify(tmp.path)} })`,
      `await new Promise(resolve => setTimeout(resolve, 10_200))`,
      `process.stdout.write("still alive")`,
    ].join("\n"),
  )
  const result = await promisify(execFile)(process.execPath, [...process.execArgv, script])
  expect(result.stdout).toBe("still alive")
}, 30_000)

test("rejects a saved thread when the selected adapter cannot resume it", async () => {
  await using tmp = await tmpdir()
  const gate = path.join(tmp.path, "finish")
  await fs.writeFile(gate, "go")
  await expect(
    runMember({
      launch: [process.execPath, ...process.execArgv, path.join(import.meta.dirname, "adapter-fixture.ts")],
      product: { id: "fixture", title: "Fixture" },
      task: { prompt: gate, cwd: tmp.path, mode: "ask", resume: "old-external-thread" },
      abort: new AbortController().signal,
      host: { step: () => {}, permission: async () => ({ allow: true }), question: async () => [] },
    }),
  ).rejects.toThrow("此适配器无法恢复已保存的外部线程")
}, 30_000)

test("persists the external session before streaming text and returns a single final reply", async () => {
  await using tmp = await tmpdir()
  const gate = path.join(tmp.path, "finish")
  const first = Promise.withResolvers<string>()
  const received: string[] = []
  let sessionID: string | undefined
  const host = {
    step: () => {},
    permission: async () => ({ allow: true as const }),
    question: async () => [],
    sessionStarted: async (input: { sessionId: string }) => {
      sessionID = input.sessionId
    },
    textDelta: (input: { delta: string }) => {
      expect(sessionID).toBe("thread-fixture")
      received.push(input.delta)
      first.resolve(input.delta)
    },
  }
  const result = runMember({
    launch: [process.execPath, ...process.execArgv, path.join(import.meta.dirname, "adapter-fixture.ts")],
    product: { id: "fixture", title: "Fixture" },
    task: { prompt: gate, cwd: tmp.path, mode: "ask" },
    abort: new AbortController().signal,
    host,
  })
  try {
    expect(await Promise.race([first.promise, result.then(() => "completed before streaming")])).toBe("Hello ")
  } finally {
    await fs.writeFile(gate, "go")
  }
  expect(await result).toMatchObject({ text: "Hello world", sessionId: "thread-fixture" })
  expect(received.join("")).toBe("Hello world")
}, 30_000)

test("withholds the session acknowledgement until asynchronous persistence completes", async () => {
  await using tmp = await tmpdir()
  const saving = Promise.withResolvers<void>()
  const checkpoint = Promise.withResolvers<string>()
  const received: string[] = []
  let saved = false
  let continued = false
  const result = runMember({
    launch: [process.execPath, ...process.execArgv, path.join(import.meta.dirname, "adapter-fixture.ts"), "ack"],
    product: { id: "fixture", title: "Fixture" },
    task: { prompt: "", cwd: tmp.path, mode: "ask" },
    abort: new AbortController().signal,
    host: {
      sessionStarted: async ({ sessionId }) => {
        expect(sessionId).toBe("thread-fixture")
        await saving.promise
        saved = true
      },
      permission: async (request) => {
        if (request.kind !== "tool") throw new Error("Unexpected fixture permission")
        if (request.name === "ack-pending" || request.name === "ack-complete") checkpoint.resolve(request.name)
        if (request.name === "after-ack") {
          expect(saved).toBe(true)
          continued = true
        }
        return { allow: true }
      },
      question: async () => [],
      step: () => {},
      textDelta: ({ delta }) => {
        expect(saved).toBe(true)
        received.push(delta)
      },
    },
  })
  try {
    expect(await Promise.race([checkpoint.promise, result.then(() => "completed before checkpoint")])).toBe(
      "ack-pending",
    )
    expect(saved).toBe(false)
    expect(continued).toBe(false)
    expect(received).toEqual([])
    saving.resolve()
    expect(await result).toMatchObject({ text: "Hello world", sessionId: "thread-fixture" })
    expect(continued).toBe(true)
    expect(received.join("")).toBe("Hello world")
  } finally {
    saving.resolve()
    await result.catch(() => undefined)
  }
}, 30_000)

test("rejects the session acknowledgement when persistence fails without continuing the task", async () => {
  await using tmp = await tmpdir()
  const saving = Promise.withResolvers<void>()
  const checkpoint = Promise.withResolvers<string>()
  const received: string[] = []
  let continued = false
  const result = runMember({
    launch: [process.execPath, ...process.execArgv, path.join(import.meta.dirname, "adapter-fixture.ts"), "ack"],
    product: { id: "fixture", title: "Fixture" },
    task: { prompt: "", cwd: tmp.path, mode: "ask" },
    abort: new AbortController().signal,
    host: {
      sessionStarted: () => saving.promise,
      permission: async (request) => {
        if (request.kind !== "tool") throw new Error("Unexpected fixture permission")
        if (request.name === "ack-pending" || request.name === "ack-complete") checkpoint.resolve(request.name)
        if (request.name === "after-ack") continued = true
        return { allow: true }
      },
      question: async () => [],
      step: () => {},
      textDelta: ({ delta }) => {
        received.push(delta)
      },
    },
  })
  result.catch(() => undefined)
  try {
    expect(await Promise.race([checkpoint.promise, result.then(() => "completed before checkpoint")])).toBe(
      "ack-pending",
    )
    saving.reject(new Error("Fixture persistence rejected"))
    await expect(result).rejects.toThrow("Fixture persistence rejected")
    expect(continued).toBe(false)
    expect(received).toEqual([])
  } finally {
    saving.resolve()
    await result.catch(() => undefined)
  }
}, 30_000)
