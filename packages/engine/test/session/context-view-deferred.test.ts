// /context tool stats (SessionContextView.build -> resolveToolStats) apply the same deferred filtering as
// runner.resolveTools: deferred tools are excluded, tool_search is counted, and activated tools are counted again.
import { test, expect } from "vitest"
import { Instance } from "@merakcode/engine/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Session } from "@merakcode/engine/session/index"
import { Agent } from "@merakcode/engine/agent/agent"
import { SessionContextView } from "@merakcode/engine/session/context-view"
import { Identifier } from "@merakcode/util/id"
import { Message } from "@merakcode/engine/session/message"
import type { Provider } from "@merakcode/engine/provider/provider"

const model = {
  id: "claude-test",
  providerID: "anthropic",
  modelID: "claude-test",
  api: { id: "claude-test" },
  limit: { output: 4096, input: 8192, context: 16384 },
} as unknown as Provider.Model

/** A completed tool_search call, as left behind when a tool was activated in an earlier turn. */
function activatedToolSearchMessage(sessionID: string, name: string): Message.FullMsg {
  return {
    info: { id: "m_prior", role: "assistant", sessionID, agent: "build", mode: "build", time: { created: 0 } },
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

test("context view excludes default deferred tools from tool stats and counts tool_search", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const user = await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID: session.id,
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-4" },
        time: { created: Date.now() },
      })
      const agent = await Agent.get("build")
      expect(agent).toBeDefined()

      const view = await SessionContextView.build({
        messages: [{ info: user, parts: [] }] as Message.FullMsg[],
        sessionID: session.id,
        user: user as Message.UserInfo,
        agent: agent!,
        model,
        step: 1,
        includeToolStats: true,
      })
      const names = view.stats.tools.standard.names

      expect(names).not.toContain("pdf_parse")
      expect(names).not.toContain("excel_parse")
      expect(names).not.toContain("excel_write")
      expect(names).not.toContain("workflow_run")
      expect(names).toContain("tool_search")
      expect(names).toContain("read")
      expect(names).toContain("bash")
      // count = pool tools - 4 deferred + 1 tool_search
      expect(view.stats.tools.standard.count).toBeGreaterThan(0)
    },
  })
})

test("context view counts pdf_parse again after a past tool_search(pdf_parse) call", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const user = await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID: session.id,
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-4" },
        time: { created: Date.now() },
      })
      const agent = await Agent.get("build")
      expect(agent).toBeDefined()

      const view = await SessionContextView.build({
        messages: [activatedToolSearchMessage(session.id, "pdf_parse"), { info: user, parts: [] }] as Message.FullMsg[],
        sessionID: session.id,
        user: user as Message.UserInfo,
        agent: agent!,
        model,
        step: 1,
        includeToolStats: true,
      })
      const names = view.stats.tools.standard.names

      expect(names).toContain("pdf_parse")
      expect(names).not.toContain("excel_parse")
      expect(names).not.toContain("workflow_run")
      expect(names).toContain("tool_search")
    },
  })
})
