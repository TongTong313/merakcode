// End-to-end behavior of deferred tool loading in resolveTools:
// - deferred tools stay out of the tools map by default and the tool_search meta tool is injected
// - a past tool_search call re-activates its tool with the full schema
// - deferred tools removed for child sessions stay out of the tool_search list, so activating them can't fail
import { test, expect } from "vitest"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Session } from "@merakcode/engine/agent/session/index"
import { Agent } from "@merakcode/engine/agent/agent"
import { Loop } from "@merakcode/engine/agent/loop/index"
import { SessionProcessor } from "@merakcode/engine/agent/loop/processor"
import { Identifier } from "@merakcode/util/id"
import { Message } from "@merakcode/engine/agent/session/message"
import type { Provider } from "@merakcode/engine/agent/model/provider"
import { SessionContextView } from "@merakcode/engine/agent/context/context-view"

const model = {
  id: "gpt-4",
  providerID: "openai",
  modelID: "gpt-4",
  api: { id: "gpt-4" },
} as unknown as Provider.Model

/** A completed tool_search call, as left behind when the model activated a tool in an earlier turn. */
function activatedToolSearchMessage(name: string): Message.FullMsg {
  return {
    info: { id: "m_prior", role: "assistant", sessionID: "s", agent: "build", mode: "build", time: { created: 0 } },
    parts: [
      {
        type: "tool",
        callID: "c_prior",
        tool: "tool_search",
        state: {
          status: "completed",
          input: { name },
          output: "",
          title: "",
          metadata: { activatedTool: name },
          time: { start: 0, end: 0 },
        },
      },
    ],
  } as unknown as Message.FullMsg
}

/** Session, build agent and processor in a fresh temp directory, so Instance caches don't leak between tests. */
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

test("resolveTools defers pdf_parse/excel_parse/excel_write/workflow_run by default and injects tool_search", async () => {
  await withSession(async ({ session, user, agent, processor }) => {
    const { tools } = await Loop.resolveTools({
      agent,
      model,
      session,
      processor,
      bypassAgentCheck: false,
      messages: [{ info: user, parts: [] }],
    })
    // Deferred tools stay out of the map to save their full schema tokens every turn.
    expect(tools.pdf_parse).toBeUndefined()
    expect(tools.excel_parse).toBeUndefined()
    expect(tools.excel_write).toBeUndefined()
    expect(tools.workflow_run).toBeUndefined()
    expect(tools.tool_search).toBeDefined()
    expect(tools.read).toBeDefined()
    expect(tools.bash).toBeDefined()
    expect(tools.edit).toBeDefined()
    // The tool_search description lists the inactive tools.
    const desc = (tools.tool_search as { description: string }).description
    expect(desc).toContain("pdf_parse")
    expect(desc).toContain("workflow_run")
  })
})

test("resolveTools re-injects pdf_parse after a past tool_search(pdf_parse) call and keeps the rest deferred", async () => {
  await withSession(async ({ session, user, agent, processor }) => {
    const { tools } = await Loop.resolveTools({
      agent,
      model,
      session,
      processor,
      bypassAgentCheck: false,
      messages: [activatedToolSearchMessage("pdf_parse"), { info: user, parts: [] }],
    })
    expect(tools.pdf_parse).toBeDefined()
    expect(tools.excel_parse).toBeUndefined()
    expect(tools.workflow_run).toBeUndefined()
    // tool_search stays so the remaining tools can still be activated.
    expect(tools.tool_search).toBeDefined()
    // pdf_parse is hidden from the tool_search list so it isn't activated twice.
    const desc = (tools.tool_search as { description: string }).description
    expect(desc).not.toContain('name="pdf_parse"')
    expect(desc).toContain("excel_parse")
  })
})

test("resolveTools leaves workflow_run out of the child session tool_search list", async () => {
  await withSession(async ({ session, user, agent, processor }) => {
    const { tools } = await Loop.resolveTools({
      agent,
      model,
      session,
      processor,
      bypassAgentCheck: false,
      messages: [{ info: user, parts: [] }],
      child: true,
    })
    // Child sessions remove workflow_run to prevent nested workflows.
    expect(tools.workflow_run).toBeUndefined()
    expect(tools.tool_search).toBeDefined()
    // If listed, the model could activate workflow_run and the call would still fail.
    const desc = (tools.tool_search as { description: string }).description
    expect(desc).not.toContain('name="workflow_run"')
    expect(desc).toContain("pdf_parse")
  })
})

for (const scenario of [
  { name: "root", child: false, mode: "ask" as const },
  { name: "readonly child", child: true, mode: "readonly" as const },
  { name: "automatic root", child: false, mode: "auto" as const },
]) {
  test("context tool names match the prepared model tools for a " + scenario.name, async () => {
    await withSession(async ({ session, user, agent, processor }) => {
      const reportingModel = { ...model, limit: { output: 4096, input: 8192, context: 16384 } }
      const messages = [{ info: user, parts: [] }] as Message.FullMsg[]
      const resolved = await Loop.resolveTools({
        agent,
        session,
        model: reportingModel,
        processor,
        bypassAgentCheck: false,
        messages,
        permissionMode: scenario.mode,
        child: scenario.child,
        step: 2,
      })
      const view = await SessionContextView.build({
        agent,
        user,
        sessionID: session.id,
        model: reportingModel,
        messages,
        step: 2,
        includeToolStats: true,
        child: scenario.child,
        preparedTools: resolved.prepared,
      })
      expect([...view.stats.tools.standard.names, ...view.stats.tools.mcp.names].sort()).toEqual(
        Object.keys(resolved.tools).sort(),
      )
      expect(view.stats.tools.standard.names).toContain("read")
      if (scenario.child) {
        for (const id of ["subagent", "workflow_run", "plan_enter", "plan_exit"])
          expect(view.stats.tools.standard.names).not.toContain(id)
      }
      if (scenario.mode === "auto") {
        expect(view.stats.tools.standard.names).not.toContain("question")
        expect(view.stats.tools.standard.names).not.toContain("plan_enter")
      }
    })
  })
}
