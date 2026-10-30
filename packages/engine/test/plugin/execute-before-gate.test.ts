import { describe, expect, test } from "vitest"
import path from "path"
import fs from "fs/promises"
import { fileURLToPath } from "url"
import { jsonSchema, type Tool as AITool } from "ai"
import { Plugin } from "@merakcode/engine/agent/plugin/index"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Session } from "@merakcode/engine/agent/session/index"
import { Agent } from "@merakcode/engine/agent/agent"
import { Loop } from "@merakcode/engine/agent/loop/index"
import { SessionProcessor } from "@merakcode/engine/agent/loop/processor"
import { Identifier } from "@merakcode/util/id"
import { Message } from "@merakcode/engine/agent/session/message"
import { MCP } from "@merakcode/engine/agent/mcp/index"
import { Bus } from "@merakcode/engine/infra/bus/index"
import { SubAgentTool } from "@merakcode/engine/agent/tools/subagent"
import { Provider } from "@merakcode/engine/agent/model/provider"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

/**
 * Rejection semantics of gate hooks.
 *
 * As in opencode 1.16.2, a throw from `tool.execute.before` or `command.execute.before` rejects the call: the error
 * reaches the caller and the tool or command does not run. Other hooks stay fault-tolerant: a throw only marks the
 * plugin degraded and execution continues.
 *
 * The plugin is a real file in a temp directory and plugin dispatch is not mocked, since dispatch error handling is
 * what is under test. The before hook writes a `REJECTED` marker and throws; the tool body writes a side-effect
 * marker; `allowed: true` lets the call through to check that the next valid call still runs after a rejection.
 */

const REJECTION = "FIXTURE_POLICY_REJECT"

/** Write the fixture plugin under `.merakcode/plugin/`; zod is symlinked in so no install hits the network */
async function writePlugin(dir: string) {
  const root = path.join(dir, ".merakcode")
  await fs.mkdir(path.join(root, "plugin"), { recursive: true })
  await fs.mkdir(path.join(root, "node_modules"), { recursive: true })
  await fs.symlink(
    path.dirname(fileURLToPath(import.meta.resolve("zod"))),
    path.join(root, "node_modules", "zod"),
    process.platform === "win32" ? "junction" : "dir",
  )
  await Filesystem.write(
    path.join(root, "plugin", "gate.ts"),
    [
      'import fs from "fs/promises"',
      'import path from "path"',
      'import { z } from "zod"',
      "export const gate = async ({ directory }) => ({",
      "  tool: {",
      "    fixture_effect: {",
      '      description: "fixture side effect",',
      "      args: { allowed: z.boolean().optional() },",
      "      execute: async () => {",
      '        await fs.writeFile(path.join(directory, "side-effect.txt"), "SIDE_EFFECT_EXECUTED")',
      '        return "done"',
      "      },",
      "    },",
      "  },",
      '  "tool.execute.before": async (_input, output) => {',
      "    if (output.args?.allowed === true) return",
      '    await fs.writeFile(path.join(directory, "before-hook.txt"), "REJECTED")',
      `    throw new Error("${REJECTION}")`,
      "  },",
      '  "command.execute.before": async () => {',
      `    throw new Error("${REJECTION}")`,
      "  },",
      '  "chat.params": async () => {',
      '    throw new Error("observer bug")',
      "  },",
      "})",
      'export default { id: "gate-fixture", server: gate }',
      "",
    ].join("\n"),
  )
}

const exists = (file: string) => Filesystem.isFile(file)

const model = {
  id: "gpt-4",
  providerID: "openai",
  modelID: "gpt-4",
  api: { id: "gpt-4" },
} as unknown as Provider.Model

/** Build the real tool table (execute as wrapped by resolveTools), the same one the runner gives the model */
async function withTools(fn: (ctx: { dir: string; tools: Record<string, AITool> }) => Promise<void>) {
  await using tmp = await tmpdir({ git: true, init: writePlugin })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const user = (await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID: session.id,
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-4" },
        time: { created: Date.now() },
      })) as Message.UserInfo
      const assistant = (await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "assistant",
        sessionID: session.id,
        mode: "build",
        agent: "build",
        path: { cwd: tmp.path, root: tmp.path },
        cost: 0,
        tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: model.id,
        providerID: model.providerID,
        parentID: user.id,
        time: { created: Date.now() },
      })) as Message.AssistantInfo
      const { tools } = await Loop.resolveTools({
        agent: (await Agent.get("build"))!,
        model,
        session,
        processor: SessionProcessor.create({
          assistantInfo: assistant,
          sessionID: session.id,
          model,
          abort: new AbortController().signal,
        }),
        bypassAgentCheck: false,
        messages: [{ info: user, parts: [] }],
        // Auto mode so plugin tools don't wait on approval; only the gate hooks are under test
        permissionMode: "auto",
      })
      await fn({ dir: tmp.path, tools })
    },
  })
}

function execute(tool: AITool | undefined, args: Record<string, unknown>) {
  expect(tool?.execute).toBeDefined()
  return Promise.resolve(
    tool!.execute!(args, {
      toolCallId: Identifier.ascending("part"),
      abortSignal: new AbortController().signal,
      messages: [],
      context: {},
    }),
  )
}

describe("gate hooks reject by throwing", () => {
  test("a throwing tool.execute.before makes trigger throw the rejection and keeps the plugin active", async () => {
    await using tmp = await tmpdir({ init: writePlugin })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rejected = Plugin.trigger(
          "tool.execute.before",
          { tool: "write", sessionID: "ses_gate", callID: "call_gate" },
          { args: {} },
        )
        await expect(rejected).rejects.toThrow(REJECTION)
        const status = (await Plugin.statuses()).find((item) => item.id === "gate-fixture")
        expect(status?.status).toBe("active")
      },
    })
  })

  test("a throwing non-gate hook is tolerated: trigger returns and the plugin is marked degraded", async () => {
    await using tmp = await tmpdir({ init: writePlugin })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const output = { temperature: 0.5 }
        const result = await Plugin.trigger("chat.params", {} as never, output as never)
        expect(result).toBe(output as never)
        const status = (await Plugin.statuses()).find((item) => item.id === "gate-fixture")
        expect(status?.status).toBe("degraded")
        expect(status?.error).toContain("observer bug")
      },
    })
  })

  test("a rejected plugin tool does not run or cause side effects, and the next valid call runs", async () => {
    await withTools(async ({ dir, tools }) => {
      await expect(execute(tools.fixture_effect, {})).rejects.toThrow(REJECTION)
      expect(await Filesystem.readText(path.join(dir, "before-hook.txt"))).toBe("REJECTED")
      expect(await exists(path.join(dir, "side-effect.txt"))).toBe(false)
      expect((await Plugin.statuses()).find((item) => item.id === "gate-fixture")?.status).toBe("active")

      await execute(tools.fixture_effect, { allowed: true })
      expect(await Filesystem.readText(path.join(dir, "side-effect.txt"))).toBe("SIDE_EFFECT_EXECUTED")
    })
  })

  test("a rejected built-in write does not create the target file", async () => {
    await withTools(async ({ dir, tools }) => {
      const target = path.join(dir, "blocked.txt")
      await expect(execute(tools.write, { filePath: target, content: "x" })).rejects.toThrow(REJECTION)
      expect(await exists(target)).toBe(false)
    })
  })

  test("a rejected slash or @ subtask creates no child session, errors its card and ends the turn", async () => {
    // The model is only needed for setup and is never called: the session is cancelled once the subtask is rejected
    const realGetModel = Provider.getModel
    Provider.getModel = (async () => ({
      ...model,
      api: { id: "gpt-4", npm: "@ai-sdk/openai", url: "http://127.0.0.1:9" },
      capabilities: { toolcall: true, input: { text: true }, output: { text: true } },
      limit: { context: 100_000, output: 10_000 },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      options: {},
      headers: {},
    })) as unknown as typeof Provider.getModel
    try {
      await using tmp = await tmpdir({ git: true, init: writePlugin })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const settled = Promise.withResolvers<Message.ToolPart>()
          const unsubscribe = Bus.subscribe(Message.Event.PartUpdated, (event) => {
            const part = event.properties.part
            if (part.type !== "tool" || part.sessionID !== session.id || part.tool !== SubAgentTool.id) return
            if (part.state.status === "running" || part.state.status === "pending") return
            Loop.cancel(session.id)
            settled.resolve(part)
          })
          try {
            await Loop.prompt({
              sessionID: session.id,
              agent: "build",
              model: { providerID: "openai", modelID: "gpt-4" },
              parts: [{ type: "subtask", agent: "general", description: "gate", prompt: "读一下 secret.txt" }],
            })
            const part = await settled.promise
            expect(part.state.status).toBe("error")
            expect(part.state.status === "error" && part.state.error).toContain(REJECTION)
            expect(await Session.children(session.id)).toHaveLength(0)
          } finally {
            unsubscribe()
          }
        },
      })
    } finally {
      Provider.getModel = realGetModel
    }
  })

  test("a throwing command.execute.before rejects the command before any user message is written", async () => {
    const realGetModel = Provider.getModel
    Provider.getModel = (async () => model) as unknown as typeof Provider.getModel
    try {
      await using tmp = await tmpdir({
        git: true,
        init: writePlugin,
        config: { command: { gatecheck: { template: "执行检查", description: "gate" } } } as never,
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const running = Loop.command({
            sessionID: session.id,
            command: "gatecheck",
            arguments: "",
            model: "openai/gpt-4",
          })
          await expect(running).rejects.toThrow(REJECTION)
          expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
        },
      })
    } finally {
      Provider.getModel = realGetModel
    }
  })

  test("a rejected MCP tool call is never sent", async () => {
    let called = false
    const original = MCP.tools
    MCP.tools = (async () => ({
      fixture_mcp_effect: {
        description: "fixture mcp tool",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => {
          called = true
          return { content: [{ type: "text" as const, text: "done" }] }
        },
      },
    })) as unknown as typeof MCP.tools
    try {
      await withTools(async ({ tools }) => {
        await expect(execute(tools.fixture_mcp_effect, {})).rejects.toThrow(REJECTION)
        expect(called).toBe(false)
      })
    } finally {
      MCP.tools = original
    }
  })
})
