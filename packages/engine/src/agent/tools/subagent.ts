import { Tool } from "./tool"
import DESCRIPTION from "./subagent.txt"
import z from "zod"
import { Session } from "../session"
import { Message } from "../session/message"
import { Identifier } from "@merakcode/util/id"
import { Agent } from "../agent"
import { Loop } from "../loop/index"
import { iife } from "@merakcode/util/iife"
import { defer } from "@merakcode/util/defer"
import { PermissionNext } from "../permission/next"
import { semaphoreFor } from "./subagent-scheduler"
import { PermissionPolicy } from "../permission/policy"

export interface SubagentMetrics {
  source: "merakcode-subagent"
  task_id: string
  message_ids: string[]
  total_tokens: number
  duration_ms: number
}

function tokenTotal(tokens: Message.AssistantInfo["tokens"] | Message.StepFinishPart["tokens"]) {
  return tokens.total ?? tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

export function summarizeSubagentMetrics(input: { taskID: string; messages: Message.FullMsg[] }): SubagentMetrics {
  const messages = input.messages.filter(
    (message): message is Message.FullMsg & { info: Message.AssistantInfo } =>
      message.info.role === "assistant" && !Message.isExternal(message.info),
  )
  if (messages.length === 0) throw new Error(`Subagent ${input.taskID} completed without an assistant message`)

  const totalTokens = messages.reduce((sum, message) => {
    const steps = message.parts.filter((part): part is Message.StepFinishPart => part.type === "step-finish")
    if (steps.length > 0) return sum + steps.reduce((total, step) => total + tokenTotal(step.tokens), 0)
    return sum + tokenTotal(message.info.tokens)
  }, 0)
  const created = Math.min(...messages.map((message) => message.info.time.created))
  const completed = messages.map((message) => message.info.time.completed)
  if (completed.some((time) => time === undefined)) {
    throw new Error(`Subagent ${input.taskID} completed without persisted completion timing`)
  }

  const duration = Math.max(...completed.filter((time): time is number => time !== undefined)) - created
  if (!Number.isInteger(totalTokens) || totalTokens <= 0) {
    throw new Error(`Subagent ${input.taskID} completed without positive runtime token usage`)
  }
  if (!Number.isInteger(duration) || duration <= 0) {
    throw new Error(`Subagent ${input.taskID} completed without positive runtime duration`)
  }

  return {
    source: "merakcode-subagent",
    task_id: input.taskID,
    message_ids: messages.map((message) => message.info.id),
    total_tokens: totalTokens,
    duration_ms: duration,
  }
}

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z
    .string()
    .describe(
      'The task for the agent to perform, including agent-specific guidance such as "Thoroughness: medium" for explore tasks',
    ),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  task_id: z
    .string()
    .describe(
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
    )
    .optional(),
  command: z.string().describe("The command that triggered this task").optional(),
  // Only applies to new sessions; ignored when task_id resumes one
  mode: z
    .enum(["fresh", "fork"])
    .default("fresh")
    .optional()
    .describe(
      "Optional context inheritance strategy for a NEW subagent session (ignored when task_id is set). " +
        "Omit this field or use 'fresh' to start with a brand-new context. " +
        "'fork': copy the main session's messages since the last compaction so the subagent inherits context. " +
        "This field does not control task thoroughness; values such as 'quick', 'medium', and 'very thorough' belong in prompt (for example, 'Thoroughness: medium'). " +
        "Note: 'fork' may significantly increase token usage; only use it when the subagent genuinely needs the prior conversation.",
    ),
})

// Lets the main agent delegate a task to a subagent. Each call creates (or resumes) a child session that runs its
// own loop; the last text part of the child session is returned as the output.
export const SubAgentTool = Tool.define("subagent", async (ctx) => {
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))

  // Subagents the caller has no "subagent" permission for are filtered out
  const caller = ctx?.agent
  // Hidden subagents (internal ones such as memory-extractor) are only visible with an explicit allow rule; the "*"
  // wildcard does not count, so hidden agents are not exposed to everyone.
  const allowsHidden = (id: string) =>
    caller?.permission.some(
      (rule) =>
        rule.permission === "subagent" &&
        rule.action === "allow" &&
        rule.pattern !== "*" &&
        PermissionNext.evaluate("subagent", id, [rule]).action === "allow",
    ) ?? false
  const accessibleAgents = caller
    ? agents.filter((a) => {
        const action = PermissionNext.evaluate("subagent", a.id, caller.permission).action
        if (action === "deny") return false
        if (a.hidden && !allowsHidden(a.id)) return false
        return true
      })
    : agents.filter((a) => !a.hidden)

  const description = DESCRIPTION.replace(
    "{agents}",
    accessibleAgents
      .map((a) => {
        // Description plus optional trigger hints (only built-in agents define them)
        const base = `- ${a.id}: ${a.description ?? "This subagent should only be called manually by the user."}`
        const hints = a.triggerHints?.length ? `\n    Trigger when: ${a.triggerHints.join("; ")}` : ""
        return base + hints
      })
      .join("\n"),
  )
  return {
    description,
    parameters,
    formatValidationError(error: z.ZodError) {
      const base = `The subagent tool was called with invalid arguments: ${error}.\nPlease rewrite the input so it satisfies the expected schema.`
      const invalidMode = error.issues.some(
        (issue) => issue.code === "invalid_value" && issue.path.length === 1 && issue.path[0] === "mode",
      )
      if (invalidMode) {
        return `${base}\nThe "mode" argument only controls context inheritance and must be "fresh" or "fork" (or omitted to use "fresh"). Put explore search thoroughness such as "quick", "medium", or "very thorough" in the "prompt" argument instead.`
      }
      return base
    },
    async execute(params: z.infer<typeof parameters>, ctx) {
      const agent = await Agent.get(params.subagent_type)
      if (!agent) throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)
      // The agent's own model, otherwise the model of the main session's current turn; shown on the approval card
      const inherited = await Message.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
        .then((msg) =>
          msg.info.role === "assistant" && !Message.isExternal(msg.info)
            ? { modelID: msg.info.modelID, providerID: msg.info.providerID }
            : undefined,
        )
        .catch(() => undefined)
      const planned = agent.model ?? inherited

      // Ask before delegating; @ mentions and slash-command subtasks skip this via bypassAgentCheck
      if (!ctx.extra?.bypassAgentCheck) {
        await ctx.ask({
          permission: "subagent",
          checks: [PermissionPolicy.subagent(params.subagent_type)],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
            mode: params.mode ?? "fresh",
            model: planned ? `${planned.providerID}/${planned.modelID}` : undefined,
          },
        })
      }

      // Each subagent holds a slot of its parent session's semaphore for the whole prompt and releases it in finally.
      // This only caps the count; file-level safety comes from FileTime (withLock plus mtime optimistic locking).
      ctx.metadata({
        title: params.description,
        metadata: { phase: "queued" },
      })
      const release = await semaphoreFor(ctx.sessionID).acquire(ctx.abort)
      ctx.metadata({
        title: params.description,
        metadata: { phase: "executing" },
      })

      try {
        const session = await iife(async () => {
          // task_id takes precedence over mode, which is ignored when resuming
          if (params.task_id) {
            const found = await Session.get(params.task_id).catch(() => {})
            if (found) return found
          }

          // fork copies the main session's messages since its last compaction into the child session
          const contextMode = params.mode ?? "fresh"
          if (contextMode === "fork") {
            return await Session.forkAsChild({
              sessionID: ctx.sessionID,
              messageID: ctx.messageID,
              parentID: ctx.sessionID,
              title: params.description + ` (@${agent.id} fork)`,
            })
          }

          return await Session.create({
            parentID: ctx.sessionID,
            title: params.description + ` (@${agent.id} subagent)`,
          })
        })
        const fullMsg = await Message.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
        if (fullMsg.info.role !== "assistant" || Message.isExternal(fullMsg.info))
          throw new Error("Not a native assistant message")

        const model = agent.model ?? {
          modelID: fullMsg.info.modelID,
          providerID: fullMsg.info.providerID,
        }

        ctx.metadata({
          title: params.description,
          metadata: {
            sessionId: session.id,
            model,
            phase: "executing" as const,
          },
        })

        const messageID = Identifier.ascending("message")

        function cancel() {
          Loop.cancel(session.id)
        }
        ctx.abort.addEventListener("abort", cancel)
        using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))
        const promptParts = await Loop.resolvePromptParts(params.prompt)

        const before = new Set((await Session.messages({ sessionID: session.id })).map((message) => message.info.id))
        const result = await Loop.prompt({
          messageID,
          sessionID: session.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          agent: agent.id,
          // The child session has no permission mode of its own: it follows the main session (Loop.modeOf),
          // approvals appear in the main session, and nested subagents are not allowed
          parts: promptParts,
        })

        const messages = (await Session.messages({ sessionID: session.id })).filter(
          (message) => !before.has(message.info.id),
        )
        const metrics = summarizeSubagentMetrics({
          taskID: session.id,
          messages: messages.some((message) => message.info.id === result.info.id) ? messages : [...messages, result],
        })

        const text = result.parts.findLast((x) => x.type === "text")?.text ?? ""
        const reference = {
          source: metrics.source,
          task_id: metrics.task_id,
          message_ids: metrics.message_ids,
        }

        const output = [
          `task_id: ${session.id} (for resuming to continue this task if needed)`,
          "",
          "<task_result>",
          text,
          "</task_result>",
          "",
          "<task_metadata>",
          JSON.stringify(reference),
          "</task_metadata>",
        ].join("\n")

        // phase is declared in the metadata type although it is not set on completion: the UI relies on the type.
        // phase is only pushed through ctx.metadata while running; afterwards the UI infers it from the status.
        return {
          title: params.description,
          metadata: {
            sessionId: session.id,
            model,
            messageIds: metrics.message_ids,
            totalTokens: metrics.total_tokens,
            durationMs: metrics.duration_ms,
          } as {
            sessionId: string
            model: { modelID: string; providerID: string }
            messageIds: string[]
            totalTokens: number
            durationMs: number
            phase?: "queued" | "executing"
          },
          output,
        }
      } finally {
        // Release the slot whether the prompt succeeds, fails or is aborted. On failure the error propagates to the
        // main agent, where the AI SDK turns it into a tool-error.
        release()
      }
    },
  }
})
