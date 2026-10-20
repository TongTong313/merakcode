// Deferred MCP tools: servers with deferred:true mark their tools __deferred, which stay out of the tools map until
// activated; tools from servers without deferred or with deferred:false are always present. MCP.tools is patched with
// stub tools so no real MCP server is needed.
import { test, expect } from "vitest"
import { jsonSchema } from "ai"
import { Instance } from "@merakcode/engine/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Session } from "@merakcode/engine/session/index"
import { Agent } from "@merakcode/engine/agent/agent"
import { SessionRunner } from "@merakcode/engine/session/runner"
import { SessionProcessor } from "@merakcode/engine/session/processor"
import { Identifier } from "@merakcode/util/id"
import { Message } from "@merakcode/engine/session/message"
import { MCP } from "@merakcode/engine/mcp/index"
import type { Provider } from "@merakcode/engine/provider/provider"

const model = {
  id: "gpt-4",
  providerID: "openai",
  modelID: "gpt-4",
  api: { id: "gpt-4" },
} as unknown as Provider.Model

/** Stub MCP tool; deferred=true adds the __deferred marker, as MCP.tools() does. */
function mockMcpTool(id: string, deferred: boolean) {
  return {
    description: `mock mcp tool ${id}`,
    inputSchema: jsonSchema({ type: "object", properties: {} }),
    execute: async () => ({ content: [{ type: "text" as const, text: "" }] }),
    ...(deferred ? { __deferred: true } : {}),
  }
}

function withMockMcpTools(tools: Record<string, ReturnType<typeof mockMcpTool>>, fn: () => Promise<void>) {
  const orig = (MCP as { tools: () => Promise<unknown> }).tools
  ;(MCP as { tools: unknown }).tools = async () => tools
  return fn().finally(() => {
    ;(MCP as { tools: unknown }).tools = orig
  })
}

async function withSession(
  fn: (ctx: {
    session: Session.Info
    user: Message.UserInfo
    agent: Agent.Info
    processor: SessionProcessor.Info
  }) => Promise<void>,
) {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const sessionID = session.id
      const user = await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID,
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-4" },
        time: { created: Date.now() },
      })
      const agent = await Agent.get("build")
      expect(agent).toBeDefined()
      const assistantInfo = (await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "assistant",
        sessionID,
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
      const processor = SessionProcessor.create({
        assistantInfo,
        sessionID,
        model,
        abort: new AbortController().signal,
      })
      await fn({ session, user: user as Message.UserInfo, agent: agent!, processor })
    },
  })
}

test("resolveTools leaves inactive deferred MCP tools out, keeps eager ones, and lists only deferred names", async () => {
  await withSession(async ({ session, user, agent, processor }) => {
    await withMockMcpTools(
      {
        mocksrv_deferred_tool: mockMcpTool("deferred_tool", true),
        mocksrv_eager_tool: mockMcpTool("eager_tool", false),
      },
      async () => {
        const { tools } = await SessionRunner.resolveTools({
          agent,
          model,
          session,
          processor,
          bypassAgentCheck: false,
          messages: [{ info: user, parts: [] }] as Message.FullMsg[],
        })
        expect(tools.mocksrv_deferred_tool).toBeUndefined()
        expect(tools.mocksrv_eager_tool).toBeDefined()
        expect(tools.tool_search).toBeDefined()
        const desc = (tools.tool_search as { description: string }).description
        expect(desc).toContain("mocksrv_deferred_tool")
        expect(desc).not.toContain("mocksrv_eager_tool")
      },
    )
  })
})

test("resolveTools re-injects a deferred MCP tool after a past tool_search call activated it", async () => {
  await withSession(async ({ session, user, agent, processor }) => {
    await withMockMcpTools({ mocksrv_deferred_tool: mockMcpTool("deferred_tool", true) }, async () => {
      const activatedMsg = {
        info: {
          id: "m_prior",
          role: "assistant",
          sessionID: session.id,
          agent: "build",
          mode: "build",
          time: { created: 0 },
        },
        parts: [
          {
            type: "tool" as const,
            callID: "c_prior",
            tool: "tool_search",
            state: {
              status: "completed" as const,
              input: { name: "mocksrv_deferred_tool" },
              output: "",
              title: "",
              metadata: { activatedTool: "mocksrv_deferred_tool" },
              time: { start: 0, end: 0 },
            },
          },
        ],
      } as unknown as Message.FullMsg
      const { tools } = await SessionRunner.resolveTools({
        agent,
        model,
        session,
        processor,
        bypassAgentCheck: false,
        messages: [activatedMsg, { info: user, parts: [] }] as Message.FullMsg[],
      })
      expect(tools.mocksrv_deferred_tool).toBeDefined()
      expect(tools.tool_search).toBeDefined()
    })
  })
})
