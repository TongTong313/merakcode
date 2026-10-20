import path from "path"
import fs from "fs/promises"
import { ulid } from "ulid"
import z from "zod"
import { Bus } from "../bus"
import { Config } from "../config/config"
import { NotifyEvent } from "../notify/event"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { SessionNotification } from "../session/notification"
import { SessionNotificationDelivery } from "../session/notification-delivery"
import { Tool } from "./tool"
import DESCRIPTION from "./workflow.txt"
import { WorkflowRegistry } from "../workflow/registry"
import { MAX_TOTAL_WORKFLOW_AGENTS, WorkflowRuntime } from "../workflow/runtime"
import { WorkflowScriptParser } from "../workflow/script"
import { WorkflowState } from "../workflow/state"
import type { WorkflowRunMetadata, WorkflowScript } from "../workflow/types"
import { Filesystem } from "@merakcode/util/filesystem"

const parameters = z
  .object({
    name: z.string().optional().describe("Name of a workflow loaded from .merakcode/workflows/*.js"),
    script: z.string().optional().describe("Inline workflow JavaScript beginning with `export const meta = { ... }`"),
    scriptPath: z.string().optional().describe("Path to a workflow JavaScript file"),
    args: z.any().optional().describe("Arguments available to the workflow script as the `args` global"),
    resumeFromRunId: z.string().optional().describe("Prior run id to reuse unchanged agent() call results"),
  })
  .refine((value) => [value.name, value.script, value.scriptPath].filter((item) => Boolean(item?.trim())).length > 0, {
    message: "Workflow requires scriptPath, script, or name",
  })

async function description() {
  const snapshot = await WorkflowRegistry.snapshot()
  const workflows =
    snapshot.scripts.length === 0
      ? "- No predefined workflows are currently available."
      : snapshot.scripts
          .map((workflow) => `- ${workflow.name}: ${workflow.description} (${workflow.scriptPath ?? workflow.source})`)
          .join("\n")
  const failed =
    snapshot.errors.length === 0
      ? ""
      : [
          "",
          "Unavailable workflow files with parse errors:",
          ...snapshot.errors.map((item) => `- ${item.name}: ${item.error} (${item.path})`),
        ].join("\n")

  return [DESCRIPTION, "", "Available predefined workflows:", workflows, failed].filter(Boolean).join("\n")
}

function safeWorkflowFileName(name: string) {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "workflow"
  )
}

async function persistInlineScript(script: WorkflowScript, runId: string) {
  const dir = path.join(Instance.directory, ".merakcode", "workflows", "generated")
  await fs.mkdir(dir, { recursive: true })
  const scriptPath = path.join(dir, `${safeWorkflowFileName(script.name)}-${runId}.js`)
  await Filesystem.write(scriptPath, script.script)
  return scriptPath
}

async function loadScript(params: z.infer<typeof parameters>, ctx: Tool.Context): Promise<WorkflowScript> {
  if (params.scriptPath?.trim()) {
    const scriptPath = params.scriptPath.trim()
    const resolved = scriptPath.startsWith("~/")
      ? path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", scriptPath.slice(2))
      : path.resolve(Instance.worktree, scriptPath)
    const allowed =
      Instance.containsPath(resolved) ||
      (await Config.directories()).some((dir) => path.resolve(resolved).startsWith(path.resolve(dir)))
    const script = await Filesystem.readText(resolved)
    return WorkflowScriptParser.parse({ script, scriptPath: resolved, source: allowed ? "project" : "custom" })
  }

  if (params.script?.trim()) {
    return WorkflowScriptParser.parse({ script: params.script, source: "custom" })
  }

  if (params.name?.trim()) {
    const found = await WorkflowRegistry.get(params.name)
    if (!found) {
      const loadError = await WorkflowRegistry.getLoadError(params.name)
      if (loadError)
        throw new Error(`Workflow "${params.name}" failed to load from ${loadError.path}: ${loadError.error}`)
      throw new Error(`Workflow not found: ${params.name}`)
    }
    return found
  }

  throw new Error("Workflow requires scriptPath, script, or name")
}

function workflowConcurrency(script: WorkflowScript) {
  return script.maxConcurrentAgents ?? script.concurrency
}

function workflowPhases(script: WorkflowScript) {
  return script.phases.length ? script.phases : [{ title: "Workflow" }]
}

function compact(value: unknown, limit = 6000) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2)
  if (!text) return "(empty)"
  if (text.length <= limit) return text
  return text.slice(0, limit) + "\n...(truncated)"
}

function buildWorkflowNotification(metadata: WorkflowRunMetadata) {
  const failed = metadata.failedAgentCount ?? metadata.agents.filter((agent) => agent.status === "failed").length
  const completed =
    metadata.completedAgentCount ?? metadata.agents.filter((agent) => agent.status === "completed").length
  const cached = metadata.cachedAgentCount ?? metadata.agents.filter((agent) => agent.status === "cached").length
  const running = metadata.runningAgentCount ?? metadata.agents.filter((agent) => agent.status === "running").length
  const queued = metadata.queuedAgentCount ?? metadata.agents.filter((agent) => agent.status === "queued").length
  const agents = metadata.agents
    .map((agent) =>
      [
        `- ${agent.label} (${agent.agent}, ${agent.phase ?? "no phase"}): ${agent.status}`,
        agent.error ? `  error: ${agent.error}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n")
  const units = (metadata.workUnits ?? [])
    .map((unit) =>
      [
        `- ${unit.title}: ${unit.status}`,
        unit.description ? `  ${unit.description}` : "",
        unit.files?.length ? `  files: ${unit.files.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n")
  return [
    `<workflow-notification>`,
    `<run-id>${metadata.runId}</run-id>`,
    `<workflow-name>${metadata.workflowName}</workflow-name>`,
    `<status>${metadata.status}</status>`,
    metadata.phase ? `<phase>${metadata.phase}</phase>` : "",
    `<summary>Workflow "${metadata.workflowName}" reached terminal status "${metadata.status}".</summary>`,
    `<agent-summary>${completed} completed, ${cached} cached, ${failed} failed, ${running} running, ${queued} queued</agent-summary>`,
    metadata.maxConcurrentAgents
      ? `<concurrency>${metadata.maxConcurrentAgents}</concurrency>`
      : `<concurrency>dynamic</concurrency>`,
    metadata.error ? `<error>${metadata.error}</error>` : "",
    units ? `<work-units>\n${units}\n</work-units>` : "",
    agents ? `<agents>\n${agents}\n</agents>` : "",
    metadata.result !== undefined ? `<result>\n${compact(metadata.result)}\n</result>` : "",
    `</workflow-notification>`,
  ]
    .filter(Boolean)
    .join("\n")
}

async function notifyCompleted(input: {
  sessionID: string
  metadata: WorkflowRunMetadata
  model: { providerID: string; modelID: string }
  agent: string
}) {
  const final = input.metadata
  const variant = final.status === "completed" ? "success" : final.status === "aborted" ? "warning" : "error"
  await Bus.publish(NotifyEvent.ToastShow, {
    title: `Workflow ${final.workflowName}`,
    message: `${final.status}. Run ${final.runId}.`,
    titleCode: "toast.workflow.finished.title",
    messageCode: `toast.workflow.finished.${final.status}`,
    params: { workflowName: final.workflowName, runId: final.runId },
    variant,
  }).catch(() => undefined)

  await SessionNotification.enqueue({
    id: `workflow_finished_${input.sessionID}_${final.runId}`,
    sessionID: input.sessionID,
    type: "workflow.finished",
    text: buildWorkflowNotification(final),
    agent: input.agent,
    model: input.model,
    metadata: {
      runId: final.runId,
      workflowName: final.workflowName,
      status: final.status,
    },
  })
  SessionNotificationDelivery.request(input.sessionID, { delay: 0 })
}

export const WorkflowRunTool = Tool.define<typeof parameters, WorkflowRunMetadata>(
  "workflow_run",
  async () => ({
    parameters,
    description: await description(),
    async execute(params, ctx) {
      if (ctx.messages.some((msg) => msg.info.role === "assistant" && msg.info.agent === "workflow-subagent")) {
        throw new Error("workflow_run cannot be called from workflow child agents")
      }
      const runId = ulid()
      let script = await loadScript(params, ctx)
      await ctx.ask({
        permission: "workflow_run",
        patterns: [script.scriptPath ?? script.name],
        metadata: {
          workflowName: script.name,
          description: script.description,
          scriptPath: script.scriptPath,
        },
      })
      if (params.script?.trim() && !script.scriptPath) {
        const scriptPath = await persistInlineScript(script, runId)
        script = { ...script, scriptPath }
      }
      const cfg = await Config.get()
      const model =
        (ctx.extra?.model
          ? {
              providerID: ctx.extra.model.providerID,
              modelID: ctx.extra.model.id ?? ctx.extra.model.modelID,
            }
          : undefined) ?? (cfg.model ? Provider.parseModel(cfg.model) : await Provider.defaultModel())
      const resume = params.resumeFromRunId
        ? await WorkflowState.read(ctx.sessionID, params.resumeFromRunId)
        : undefined
      if (params.resumeFromRunId && !resume) throw new Error(`Unknown workflow run: ${params.resumeFromRunId}`)
      if (resume?.scriptPath && script.scriptPath && resume.scriptPath !== script.scriptPath) {
        throw new Error("resumeFromRunId must reference a run created from the same workflow scriptPath")
      }
      const now = Date.now()
      const maxConcurrentAgents = workflowConcurrency(script)
      const phases = workflowPhases(script)
      const abort = new AbortController()
      // Both a user cancel and the background runtime's catch reach the final notification; deliver the toast and
      // enqueue only once per run.
      let finishNotified = false
      const finishWorkflow = async (metadata: WorkflowRunMetadata) => {
        if (finishNotified) return
        finishNotified = true
        await notifyCompleted({
          sessionID: ctx.sessionID,
          metadata,
          model,
          agent: ctx.agent,
        }).catch(() => undefined)
      }
      if (ctx.abort.aborted) abort.abort()
      const control = {
        abort,
        async notifyCancelled() {
          // On a user cancel, deliver the aborted notification right away instead of waiting for the runtime's
          // async catch. The run is first saved as aborted (runs already in a final state are left alone), then
          // enqueued. The notification id (workflow_finished_<sessionID>_<runId>) makes enqueue idempotent, and
          // finishWorkflow keeps the toast from showing twice.
          const current = await WorkflowState.updateRun(ctx.sessionID, runId, (draft) => {
            if (draft.status === "completed" || draft.status === "failed" || draft.status === "aborted") return
            draft.status = "aborted"
            draft.completedAt = Date.now()
            draft.resumable = true
          }).catch(() => undefined)
          if (!current) return
          await finishWorkflow(current)
        },
      }
      const initial: WorkflowRunMetadata = {
        status: "running",
        workflowName: script.name,
        description: script.description,
        runId,
        messageID: ctx.messageID,
        scriptPath: script.scriptPath,
        phase: phases[0]?.title,
        phases,
        agents: [],
        logs: [],
        resumable: true,
        createdAt: now,
        updatedAt: now,
        ...(maxConcurrentAgents ? { maxConcurrentAgents } : {}),
        maxTotalAgents: MAX_TOTAL_WORKFLOW_AGENTS,
        agentCount: 0,
        queuedAgentCount: 0,
        runningAgentCount: 0,
        completedAgentCount: 0,
        failedAgentCount: 0,
        cachedAgentCount: 0,
      }

      await WorkflowState.writeRun(ctx.sessionID, ctx.messageID, initial)
      await ctx.metadata({ title: script.name, metadata: initial })

      const unregister = WorkflowState.registerRun(ctx.sessionID, runId, control)
      const directory = Instance.directory
      void Instance.provide({
        directory,
        fn: async () => {
          try {
            const result = await WorkflowRuntime.run({
              runId,
              script,
              args: params.args,
              sessionID: ctx.sessionID,
              messageID: ctx.messageID,
              abort: abort.signal,
              control,
              defaultModel: model,
              callerRuleset: ctx.ruleset,
              resume,
              hooks: {
                update: async (metadata) => {
                  await WorkflowState.writeRun(ctx.sessionID, ctx.messageID, metadata)
                  await ctx.metadata({ title: script.name, metadata })
                },
              },
            })
            const final = await WorkflowState.readRun(ctx.sessionID, runId)
            await finishWorkflow(final ?? result.metadata)
          } finally {
            unregister()
          }
        },
      }).catch(async (error) => {
        await Instance.provide({
          directory,
          fn: async () => {
            unregister()
            const current = await WorkflowState.readRun(ctx.sessionID, runId).catch(() => undefined)
            if (current?.status === "failed" || current?.status === "aborted") {
              await finishWorkflow(current)
              return
            }
            const message = error instanceof Error ? error.message : String(error)
            const failed = await WorkflowState.writeRun(ctx.sessionID, ctx.messageID, {
              ...initial,
              status: "failed",
              updatedAt: Date.now(),
              completedAt: Date.now(),
              error: message,
            })
            await finishWorkflow(failed)
          },
        })
      })

      return {
        title: script.name,
        metadata: initial,
        output: [
          "Workflow launched in background.",
          `Name: ${script.name}`,
          `Run ID: ${runId}`,
          `Workflow concurrency: ${maxConcurrentAgents ?? "dynamic"}`,
          script.scriptPath ? `Script file: ${script.scriptPath}` : undefined,
          script.scriptPath
            ? `To resume after editing the script: workflow_run({ scriptPath: ${JSON.stringify(script.scriptPath)}, resumeFromRunId: ${JSON.stringify(runId)} })`
            : undefined,
          "You will be notified automatically when it completes.",
        ]
          .filter(Boolean)
          .join("\n"),
      }
    },
  }),
  // Search terms for deferred loading (see Tool.Info.triggerHint), used for scoring only. This is the main case for
  // the mechanism: when the user asks to "use a workflow to do X" this tool must be activated, otherwise the model
  // reads "workflow" as working step by step and uses todowrite instead. Only domain words: generic ones such as
  // parallel, concurrent, batch or schedule match too many unrelated requests, and subagent is another tool's name.
  "workflow workflows 工作流 工作流程 流程编排 编排 扇出 fan-out fanout orchestrate 多智能体 子智能体",
)
