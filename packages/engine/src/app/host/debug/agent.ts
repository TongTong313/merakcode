// `merak debug agent`: inspect an agent's resolved config, or run one of its tools directly.
import { EOL } from "os"
import { Agent, STANDARD_TOOL_POOL } from "../../../agent/agent"
import { Provider } from "../../../agent/model/provider"
import { Session } from "../../../agent/session/index"
import type { Message } from "../../../agent/session/message"
import { Identifier } from "@merakcode/util/id"
import { ToolRegistry } from "../../../agent/tools/registry"
import { Tool } from "../../../agent/tools/tool"
import { Instance } from "../../../infra/project/instance"
import { PermissionNext } from "../../../agent/permission/next"
import { iife } from "@merakcode/util/iife"
import { withInstance } from "../bootstrap"
type AgentArgs = {
  id?: string
  tool?: string
  params?: string
}

export async function run(args: AgentArgs) {
  await withInstance(process.cwd(), async () => {
    const agentID = args.id as string
    const agent = await Agent.get(agentID)
    if (!agent) {
      process.stderr.write(`Agent ${agentID} not found. Run 'merak agent list' to see the available agents.` + EOL)
      process.exit(1)
    }
    const availableTools = await getAvailableTools(agent)
    const resolvedTools = await resolveTools(agent, availableTools)
    const toolID = args.tool as string | undefined
    if (toolID) {
      const tool = availableTools.find((item) => item.id === toolID)
      if (!tool) {
        process.stderr.write(`Agent ${agentID} has no tool named ${toolID}` + EOL)
        process.exit(1)
      }
      if (resolvedTools[toolID] === false) {
        process.stderr.write(`Tool ${toolID} is disabled for agent ${agentID}` + EOL)
        process.exit(1)
      }
      const params = parseToolParams(args.params as string | undefined)
      const ctx = await createToolContext(agent)
      const result = await tool.execute(params, ctx)
      process.stdout.write(JSON.stringify({ tool: toolID, input: params, result }, null, 2) + EOL)
      return
    }

    const output = {
      ...agent,
      tools: resolvedTools,
    }
    process.stdout.write(JSON.stringify(output, null, 2) + EOL)
  })
}

async function getAvailableTools(agent: Agent.Info) {
  const model = agent.model ?? (await Provider.defaultModel())
  return ToolRegistry.tools(model, agent)
}

async function resolveTools(agent: Agent.Info, availableTools: Awaited<ReturnType<typeof getAvailableTools>>) {
  const pool = new Set(agent.profile?.availableTools ?? STANDARD_TOOL_POOL)
  const dynamic = await ToolRegistry.dynamicIds()
  const resolved: Record<string, boolean> = {}
  for (const tool of availableTools) {
    resolved[tool.id] = pool.has(tool.id) || (pool.has("plugin") && dynamic.has(tool.id))
  }
  return resolved
}

function parseToolParams(input?: string) {
  if (!input) return {}
  const trimmed = input.trim()
  if (trimmed.length === 0) return {}

  const parsed = iife(() => {
    try {
      return JSON.parse(trimmed)
    } catch (jsonError) {
      try {
        return new Function(`return (${trimmed})`)()
      } catch (evalError) {
        throw new Error(
          `Failed to parse --params. Use JSON or a JS object literal. JSON error: ${jsonError}. Eval error: ${evalError}.`,
        )
      }
    }
  })

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool params must be an object.")
  }
  return parsed as Record<string, unknown>
}

async function createToolContext(agent: Agent.Info) {
  const session = await Session.create({ title: `Debug tool run (${agent.name})` })
  const messageID = Identifier.ascending("message")
  const model = agent.model ?? (await Provider.defaultModel())
  const now = Date.now()
  const assistantInfo: Message.AssistantInfo = {
    id: messageID,
    sessionID: session.id,
    role: "assistant",
    time: {
      created: now,
    },
    parentID: messageID,
    modelID: model.modelID,
    providerID: model.providerID,
    mode: "debug",
    agent: agent.id,
    path: {
      cwd: Instance.directory,
      root: Instance.worktree,
    },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
  }
  await Session.updateInfo(assistantInfo)

  const ruleset = PermissionNext.merge(agent.permission, session.permission ?? [], agent.profile?.restrictedRules ?? [])

  const ctx: Tool.Context = {
    sessionID: session.id,
    messageID,
    callID: Identifier.ascending("part"),
    agent: agent.id,
    permissionMode: "ask",
    kind: "ask",
    abort: new AbortController().signal,
    messages: [],
    ruleset,
    metadata: () => {},
    // Debug runs skip approval prompts and only enforce explicit deny rules
    async ask(req) {
      const checks = req.checks ?? (req.patterns ?? []).map((pattern) => ({ permission: req.permission, pattern }))
      if (checks.some((check) => PermissionNext.evaluate(check.permission, check.pattern, ruleset).action === "deny"))
        throw new PermissionNext.DeniedError(ruleset)
    },
  }
  return ctx
}
