import { afterEach, beforeEach, expect, test } from "vitest"
import { Identifier } from "@merakcode/util/id"
import { Auth } from "@merakcode/engine/auth/index"
import { Instance } from "@merakcode/engine/project/instance"
import { Provider } from "@merakcode/engine/provider/provider"
import { Session } from "@merakcode/engine/session/index"
import { Message } from "@merakcode/engine/session/message"
import { SessionDispatch } from "@merakcode/engine/session/dispatch"
import { SessionRunner } from "@merakcode/engine/session/runner"
import { LLM } from "@merakcode/engine/session/llm"
import { Database } from "@merakcode/engine/storage/db"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"
import { setTimeout as delay } from "node:timers/promises"

Log.init({ print: false })

const realStream = LLM.stream
const realGetModel = Provider.getModel
const realGetProvider = Provider.getProvider
const realGetAuth = Auth.get

beforeEach(() => {
  Provider.getModel = (async () => ({
    id: "test-model",
    providerID: "test-provider",
    modelID: "test-model",
    api: { id: "test-model", npm: "@ai-sdk/openai-compatible" },
    limit: { context: 128000, output: 8192 },
  })) as unknown as typeof Provider.getModel
  Provider.getProvider = (async () => ({ id: "test-provider", options: {} })) as unknown as typeof Provider.getProvider
  Auth.get = (async () => undefined) as unknown as typeof Auth.get
})

afterEach(async () => {
  LLM.stream = realStream
  Provider.getModel = realGetModel
  Provider.getProvider = realGetProvider
  Auth.get = realGetAuth
  await Instance.disposeAll()
})

function user(sessionID: string): Message.UserInfo {
  return {
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    agent: "build",
    model: { providerID: "test-provider", modelID: "test-model" },
    time: { created: Date.now() },
  }
}

function assistant(sessionID: string, parentID: string): Message.AssistantInfo {
  return {
    id: Identifier.ascending("message"),
    sessionID,
    role: "assistant",
    parentID,
    modelID: "test-model",
    providerID: "test-provider",
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now() },
    finish: "tool-calls",
  }
}

/** Seeds a turn left mid-tool as if the engine crashed before cancel reconciliation. */
async function seedStuckBash(sessionID: string) {
  const asked = await Session.updateInfo(user(sessionID))
  const reply = await Session.updateInfo(assistant(sessionID, asked.id))
  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID,
    messageID: reply.id,
    type: "tool",
    callID: "call-crash",
    tool: "bash",
    state: {
      status: "running",
      input: { command: "pnpm test" },
      time: { start: Date.now() },
    },
  } satisfies Message.ToolPart)
  return { asked, reply }
}

function toolRows(sessionID: string) {
  const rows = Database.query("SELECT data FROM part WHERE session_id = ? ORDER BY id").all(sessionID) as {
    data: string
  }[]
  return rows.map((row) => JSON.parse(row.data)).filter((part) => part.type === "tool")
}

test("Session.get after a restart marks a stuck running tool as an interrupted error", async () => {
  await using tmp = await tmpdir({ git: true })
  let sessionID = ""

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      sessionID = session.id
      await seedStuckBash(sessionID)
    },
  })

  // Fresh Instance context simulates an engine restart with the same on-disk session.
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Session.get(sessionID)
      const messages = await Session.messages({ sessionID })
      const tools = messages
        .flatMap((message) => message.parts)
        .filter((part): part is Message.ToolPart => part.type === "tool")
      expect(tools).toHaveLength(1)
      expect(tools[0]!.state.status).toBe("error")
      if (tools[0]!.state.status !== "error") throw new Error("expected error")
      expect(tools[0]!.state.error).toMatch(/restart|重启/i)
    },
  })
})

test("disposing a live session settles its unfinished tools", async () => {
  await using tmp = await tmpdir({ git: true })
  let sessionID = ""
  const hang = process.platform === "win32" ? "ping -n 60 127.0.0.1 >nul" : "sleep 60"

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      sessionID = session.id
      const running = SessionRunner.shell({
        sessionID,
        agent: "build",
        model: { providerID: "test-provider", modelID: "test-model" },
        command: hang,
      }).catch(() => undefined)

      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        if (toolRows(sessionID).some((part) => part.state?.status === "running")) break
        await delay(50)
      }
      expect(toolRows(sessionID).some((part) => part.state?.status === "running")).toBe(true)
      // Keep the promise referenced so the shell stays owned until Instance.disposeAll tears it down.
      void running
    },
  })
  await Instance.disposeAll()

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const tools = toolRows(sessionID)
      expect(tools.length).toBeGreaterThan(0)
      expect(tools.every((part) => part.state.status === "error")).toBe(true)
      expect(tools.some((part) => /restart|重启|aborted|中断/i.test(part.state.error ?? ""))).toBe(true)
    },
  })
}, 30_000)

test("Session.get after a restart leaves a detached workflow_run tool running for WorkflowState to settle", async () => {
  await using tmp = await tmpdir({ git: true })
  let sessionID = ""

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      sessionID = session.id
      const asked = await Session.updateInfo(user(sessionID))
      const reply = await Session.updateInfo(assistant(sessionID, asked.id))
      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID,
        messageID: reply.id,
        type: "tool",
        callID: "call-workflow",
        tool: "workflow_run",
        state: {
          status: "running",
          input: { name: "demo" },
          metadata: { status: "running", workflowName: "demo", runId: "run-1" },
          time: { start: Date.now() },
        },
      } satisfies Message.ToolPart)
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Session.get(sessionID)
      const messages = await Session.messages({ sessionID })
      const tool = messages
        .flatMap((message) => message.parts)
        .find((part): part is Message.ToolPart => part.type === "tool" && part.tool === "workflow_run")
      expect(tool?.state.status).toBe("running")
    },
  })
})

test("a prompt after crash recovery replies under the new user message, not the stuck turn", async () => {
  LLM.stream = (async () => ({
    stream: (async function* () {
      yield { type: "start" }
      yield { type: "text-start", id: "t1" }
      yield { type: "text-delta", id: "t1", text: "continuing" }
      yield { type: "text-end", id: "t1" }
      yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: "finish" }
    })(),
  })) as unknown as typeof LLM.stream

  await using tmp = await tmpdir({ git: true })
  let sessionID = ""
  let stuckUserID = ""

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      sessionID = session.id
      const seeded = await seedStuckBash(sessionID)
      stuckUserID = seeded.asked.id
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Session.get(sessionID)
      const reply = await SessionDispatch.prompt({
        sessionID,
        agent: "build",
        model: { providerID: "test-provider", modelID: "test-model" },
        parts: [{ type: "text", text: "继续" }],
      })
      expect(reply.info.role).toBe("assistant")
      if (reply.info.role !== "assistant") throw new Error("expected assistant")
      expect(reply.info.parentID).not.toBe(stuckUserID)
      const messages = await Session.messages({ sessionID })
      const continueUser = messages.findLast(
        (message) =>
          message.info.role === "user" && message.parts.some((part) => part.type === "text" && part.text === "继续"),
      )
      expect(continueUser).toBeDefined()
      expect(reply.info.parentID).toBe(continueUser!.info.id)
    },
  })
}, 60_000)
