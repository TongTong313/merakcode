import { permissionLevelOf, permissionLevelNow } from "../permission/permission-level"
import { startsSessionPlan, resumesSessionPlan } from "@merakcode/util/session-plan"
import { ModeOperations } from "../permission/operations"
import { Lock } from "../../infra/concurrency/lock"
import { SessionPlan } from "../session/plan"
import { SessionStore } from "../session/store"
import path from "path"
import os from "os"
import fs from "fs/promises"
import z from "zod"
import { Identifier } from "@merakcode/util/id"
import { Message } from "../session/message"
import { Log } from "@merakcode/log/logger"
import { SessionRevert } from "./revert"
import { SessionReference } from "../session/reference"
import { SessionUndoRedo } from "./undo-redo"
import { cancelSessionTree, awaitLoopStopped } from "./cancel-tree"
import { Session } from "../session"
import { SessionTarget } from "../session/target"
import { Storage } from "../../infra/storage/storage"
import { Agent, STANDARD_TOOL_POOL } from "../agent"
import { autoActivationMetadata } from "../tools/tool-search"
import { Provider } from "../model/provider"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema, type ModelMessage } from "ai"
import { SessionCompaction } from "../context/compaction"
import { SessionContextView } from "../context/context-view"
import { PlanCapacity } from "../context/plan-capacity"
import { Token } from "../context/token"
import { SessionContextLayer } from "../context/context-layer"
import { Instance } from "../../infra/project/instance"
import { Checkout } from "../../infra/project/checkout"
import { Bus } from "../../infra/bus"
import { ProviderTransform } from "../model/transform"
import { ContextAttach } from "../context/context-attach"
import { Plugin } from "../plugin"
import MAX_STEPS from "../prompt/templates/max-steps.txt"
import { defer } from "@merakcode/util/defer"
import { prepareTools } from "../tools/prepare"
import { PromptMode } from "../context/prompt-mode"
import { LoopExecution } from "./execution"
import { MCP } from "../mcp"
import { LSP } from "../lsp"
import { ReadTool } from "../tools/read"
import { FileTime } from "../../infra/file/time"
import { RuleSession } from "../prompt/rules/session-state"
import { ulid } from "ulid"
import { spawn } from "child_process"
import { Command } from "../prompt/command"
import { Skill } from "../skill"
import { fileURLToPath, pathToFileURL } from "url"
import { ConfigMarkdown } from "../../infra/config/markdown"
import { SessionSummary } from "./summary"
import { NamedError } from "@merakcode/util/error"
import { fn } from "@merakcode/util/fn"
import { SessionProcessor } from "./processor"
import { SubAgentTool } from "../tools/subagent"
import { Tool } from "../tools/tool"
import { PermissionNext } from "../permission/next"
import { Question } from "../session/question/index"
import { PermissionLevel } from "../permission/level"
import { PermissionPolicy } from "../permission/policy"
import { LoopStatus } from "./status"
import { LoopRequest } from "./request"
import { scheduleTurnCompletion } from "./completion"
import { SessionNotification } from "../session/notification"
import { SessionTitle } from "./title"
import { lazy } from "@merakcode/util/lazy"
import { Shell } from "../../infra/process/shell/shell"
import { Truncate } from "../tools/truncation"
import { metadataTail } from "../tools/output-sink"
import { Transcript } from "../session/transcript"
import { SessionContextReport } from "../context/context-report"
import { SkillSearch } from "../skill/search"
import { MemoryRecall } from "../memory/recall"
import { Filesystem } from "@merakcode/util/filesystem"
import { Text } from "../prompt/text"
import { SessionCrash } from "./crash-reconcile"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

// Max output tail streamed while Loop.shell runs; matches MAX_METADATA_LENGTH in the bash tool.
const SHELL_METADATA_LENGTH = 30_000

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

export namespace Loop {
  type WorkflowCancellation = {
    list(sessionID: string): Promise<Array<{ runId: string; status: string; planExecutionID?: string }>>
    cancel(sessionID: string, runID: string): Promise<unknown>
  }
  let workflows: WorkflowCancellation = { list: async () => [], cancel: async () => {} }

  export function useWorkflows(adapter: WorkflowCancellation) {
    workflows = adapter
  }

  /** Request admission, target dispatch and cancellation shared by HTTP and in-process callers. */
  export const Request: typeof LoopRequest = {
    // Request dispatch also calls the native loop; read its live binding when invoked, after both modules load.
    command: (input) => LoopRequest.command(input),
    prompt: (input) => LoopRequest.prompt(input),
    startPlan: (sessionID, selection) => LoopRequest.startPlan(sessionID, selection),
    cancel: (sessionID) => LoopRequest.cancel(sessionID),
  }
  /** Process-local busy/retry state and the existing session status events. */
  export const Status = LoopStatus

  /** Starts an idle session outside the request that created its background task. */
  export function background(input: PromptInput): Promise<boolean> {
    return LoopExecution.run(undefined, async () => {
      if (LoopStatus.get(input.sessionID).type !== "idle") return false
      await Loop.prompt(input)
      return true
    })
  }
  const log = Log.create({ service: "session.runner" })
  const WRITE_PIVOT_TOOLS = new Set(["bash", "write", "edit", "multi_edit"])

  export type SkillDiscoveryTrigger = {
    id: string
    kind: "user_message" | "write_pivot"
  }

  export type SkillDiscoveryPrefetch = {
    trigger: SkillDiscoveryTrigger
    promise: Promise<SkillSearch.Attachment | undefined>
  }

  /** Deferred resolved when the owner loop body exits, so cancelTree can wait until the loop has really stopped. */
  function makeDone(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void
    const promise = new Promise<void>((r) => (resolve = r))
    return { promise, resolve }
  }

  type QueuedPrompt = {
    input: PromptInput
    scope?: LoopExecution.Scope
    options?: {
      requireIdle?: boolean
      commandSource?: Message.UserInfo["commandSource"]
    }
    message?: Message.FullMsg
    resolve(input: Message.FullMsg): void
    reject(reason?: any): void
  }

  type TurnCallback = {
    scope?: LoopExecution.Scope
    resolve(input: Message.FullMsg): void
    reject(reason?: any): void
  }

  type LoopState = {
    abort: AbortController
    toolAborts: Map<string, AbortController>
    running?: boolean
    callbacks: TurnCallback[]
    activeCallback?: TurnCallback
    queuedPrompts: QueuedPrompt[]
    /** Resolved when the owner loop body exits, after the processor has written any in-flight PatchPart. */
    done: { promise: Promise<void>; resolve: () => void }
    releaseCheckout: () => void
  }

  // Runtime state is scoped per Instance.
  const state = Instance.state(
    () => {
      const data: Record<string, LoopState> = {}
      return data
    },
    async (current) => {
      const sessionIDs = Object.keys(current)
      for (const item of Object.values(current)) {
        item.abort.abort()
        item.activeCallback?.reject(new Message.AbortedError({ message: "Instance disposed" }))
        for (const q of item.callbacks) {
          q.reject(new Message.AbortedError({ message: "Instance disposed" }))
        }
        item.callbacks = []
        for (const q of item.queuedPrompts) {
          q.reject(new Message.AbortedError({ message: "Instance disposed" }))
        }
        item.queuedPrompts = []
        item.done.resolve() // Release waiters on dispose so cancelTree does not hang.
      }
      // Persist unfinished tools for sessions that still had a live loop: cancel reconciliation may not have run
      // before process exit. Idle zombies left by a hard crash are settled later via Session.get.
      if (sessionIDs.length) {
        const { SessionCrash } = await import("./crash-reconcile")
        for (const sessionID of sessionIDs) await SessionCrash.settleDisposed(sessionID)
      }
    },
  )
  const reconciliations = Instance.state(() => new Map<string, Promise<void>>())
  const cancelledPromptSettlements = Instance.state(() => new Map<string, Promise<void>>())
  /**
   * Prompts that were accepted but not yet queued: there are async steps (hooks, persistence) between writing the
   * message and enqueueing it. A hard stop must cancel them too, or the message starts running after the stop;
   * an interrupt only stops the current turn and keeps them.
   */
  const admissions = Instance.state(() => new Map<string, Set<AbortController>>())

  function admit(sessionID: string) {
    const releaseCheckout = Checkout.hold()
    const controller = new AbortController()
    const entries = admissions().get(sessionID) ?? new Set<AbortController>()
    entries.add(controller)
    admissions().set(sessionID, entries)
    return {
      signal: controller.signal,
      release() {
        releaseCheckout()
        entries.delete(controller)
        if (entries.size === 0 && admissions().get(sessionID) === entries) admissions().delete(sessionID)
      },
    }
  }

  export function assertNotBusy(sessionID: string) {
    const match = state()[sessionID]
    if (match) throw new Session.BusyError(sessionID)
  }

  export const PromptInput = z.object({
    sessionID: Identifier.schema("session"),
    messageID: Identifier.schema("message").optional(),
    model: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
      })
      .optional(),
    agent: z.string().optional(),
    noReply: z.boolean().optional(),
    tools: z
      .record(z.string(), z.boolean())
      .optional()
      .describe(
        "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
      ),
    format: Message.Format.optional(),
    system: z.string().optional(),
    variant: z.string().optional(),
    permissionLevel: PermissionLevel.Schema.optional(),
    permissionMode: z
      .enum(["readonly", "ask"])
      .optional()
      .describe("Deprecated mode input; legacy auto must be explicitly reauthorized through permissionLevel."),
    /** Per-turn metadata. The engine does not interpret it and copies it to `UserInfo.metadata`. */
    metadata: z.record(z.string(), z.unknown()).optional(),
    /** @deprecated Use permissionLevel. Still parsed for older SubAgentTool / SDK callers. */
    kind: PermissionLevel.Schema.optional(),
    /** Max loop turns for a forked child session, so extraction/notes agents cannot burn tokens. */
    maxTurns: z.number().optional(),
    parts: z.array(
      z.discriminatedUnion("type", [
        Message.TextPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "TextPartInput",
          }),
        Message.FilePart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "FilePartInput",
          }),
        Message.AgentPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "AgentPartInput",
          }),
        Message.SubtaskPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "SubtaskPartInput",
          }),
      ]),
    ),
  })

  export type PromptInput = z.infer<typeof PromptInput>

  async function prepareAndCreatePromptMessage(
    input: PromptInput,
    options?: {
      commandSource?: Message.UserInfo["commandSource"]
    },
  ): Promise<Message.FullMsg> {
    LoopExecution.check(input.sessionID)
    const session = await LoopExecution.wait(async () => SessionTarget.assertNativeOperation(input.sessionID))
    if (!session) throw new Storage.NotFoundError({ message: `Resource not found: session ${input.sessionID}` })
    // A new message discards the redo history.
    if (session.undoRedo?.stack?.length) {
      await LoopExecution.wait(async () => SessionUndoRedo.discard({ sessionID: session.id }))
    } else if (session.revert) {
      await LoopExecution.wait(async () => SessionRevert.cleanup(session))
    }

    const allMsgs = await LoopExecution.wait(async () => Message.filterCompacted(Message.stream(input.sessionID)))
    const lastID = allMsgs.at(-1)?.info.id
    const freshID = Identifier.ascending("message")
    const messageID = !input.messageID || (lastID && input.messageID <= lastID) ? freshID : input.messageID

    const message = await LoopExecution.wait(async () =>
      createUserMessage({ ...input, messageID }, options?.commandSource),
    )
    await LoopExecution.wait(async () => Session.touch(input.sessionID))

    // this is backwards compatibility for allowing `tools` to be specified when
    // prompting
    //
    // input.tools can only disable tools: false is persisted as deny (omitting tools next turn does not re-enable it);
    // true grants nothing, otherwise any client message could bypass the permission mode.
    const permissions: PermissionNext.Ruleset = Object.entries(input.tools ?? {})
      .filter(([tool, enabled]) => !enabled && !PermissionNext.INTERNAL_PERMISSION_KEYS.has(tool))
      .map(([tool]) => ({ permission: tool, action: "deny" as const, pattern: "*" }))
    if (permissions.length > 0) {
      // Merge into the persisted permissions instead of overwriting session.permission in memory, which would drop
      // previously accumulated rules and let memory and storage diverge.
      await LoopExecution.wait(async () =>
        Session.update(session.id, (draft) => {
          draft.permission = PermissionNext.mergeUnique(draft.permission ?? [], permissions)
        }),
      )
    }

    if (input.noReply === true) {
      return message
    }

    // Whole-turn refusal hook. The engine ships no keyword list or refusal text; plugins decide, and this only fires
    // the hook at the right point. Without a plugin, refuse stays false and nothing is refused.
    if (message.info.role === "user") {
      const sources = message.info.commandSource ? Message.userSourceTexts(message) : []
      const guardInputs = sources.length
        ? sources.map((text) => [
            { type: "text" as const, text },
            ...message.parts.filter((part) => part.type === "file"),
          ])
        : [message.parts]
      for (const parts of guardInputs) {
        const guard = await LoopExecution.wait(async () =>
          Plugin.trigger(
            "experimental.chat.guard",
            { sessionID: input.sessionID, agent: message.info.agent, role: message.info.role, parts },
            { refuse: false, message: "" },
          ),
        )
        if (guard.refuse) {
          return createRefusal({
            user: message.info,
            agent: message.info.agent,
            message: guard.message || undefined,
          })
        }
      }
    }

    return message
  }

  async function promptInternal(
    input: PromptInput,
    options?: {
      requireIdle?: boolean
      commandSource?: Message.UserInfo["commandSource"]
    },
  ): Promise<Message.FullMsg> {
    if (LoopExecution.current() && !LoopExecution.current(input.sessionID)) {
      return LoopExecution.run(undefined, () => promptInternal(input, options))
    }
    LoopExecution.check(input.sessionID)
    if (options?.requireIdle === true) {
      assertNotBusy(input.sessionID)
    }

    await SessionCrash.reconcile(input.sessionID, () => Boolean(resume(input.sessionID)))
    const admission = admit(input.sessionID)
    try {
      const message = await prepareAndCreatePromptMessage(input, options)
      LoopExecution.check(input.sessionID)
      if (input.noReply === true || message.info.role === "assistant") {
        return message
      }
      if (admission.signal.aborted) {
        await settleCancelledPrompt(message)
        throw admission.signal.reason
      }

      // Enqueueing and starting the loop are synchronous, so a hard stop cannot interleave before finally.
      const s = state()[input.sessionID]
      if (s && s.running) {
        log.info("session busy, enqueueing prompt message", { sessionID: input.sessionID, messageID: message.info.id })
        return new Promise<Message.FullMsg>((resolve, reject) => {
          s.queuedPrompts.push({
            input,
            scope: LoopExecution.current(input.sessionID),
            options,
            message,
            resolve,
            reject,
          })
        })
      }

      return run({
        sessionID: input.sessionID,
        permissionLevel:
          message.info.role === "user" ? message.info.permissionLevel : (input.permissionLevel ?? input.kind),
        maxTurns: input.maxTurns,
      })
    } finally {
      admission.release()
    }
  }
  // Public prompts cannot decide whether text is hidden from the UI or security policy; only the engine sets
  // synthetic and ignored.
  function publicPromptInput(input: PromptInput): PromptInput {
    return {
      ...input,
      parts: input.parts.map((part) => {
        if (part.type !== "text") return part
        const { synthetic: _synthetic, ignored: _ignored, ...text } = part
        return text
      }),
    }
  }
  const planStarts = Instance.state(() => new Map<string, { promise: Promise<Message.FullMsg>; settled: boolean }>())
  const planSources = Instance.state(() => new Map<string, "button" | "chat">())
  const planPauses = Instance.state(() => new Map<string, Promise<void>>())

  export async function planPaused(sessionID: string) {
    const rootID = await Session.rootID(sessionID)
    return planPauses().has(rootID) || (await SessionPlan.get(rootID)).status === "paused"
  }

  async function planWorkflows(rootID: string) {
    const sessions = [rootID, ...(await Session.descendants(rootID)).map((session) => session.id)]
    return (
      await Promise.all(
        sessions.map(async (sessionID) => (await workflows.list(sessionID)).map((run) => ({ ...run, sessionID }))),
      )
    ).flat()
  }

  async function waitForPlanPause(pending: Promise<void>, error: InstanceType<typeof Message.PlanCapacityError>) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            void Text.pick({
              zh: "计划容量不足。仍有操作尚未确认停止，该对话暂不派发新操作。",
              en: "The plan exceeds capacity. An operation has not confirmed stopping; new work for this conversation is blocked.",
            }).then((message) => reject(new Message.PlanCapacityError({ ...error.data, message })), reject)
          }, 3000)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  function pausePlan(rootID: string, executionID: string, error: InstanceType<typeof Message.PlanCapacityError>) {
    const current = planPauses().get(rootID)
    if (current) return waitForPlanPause(current, error)
    const unblock = ModeOperations.block(rootID, error.data.message)
    const pending = (async () => {
      const { BashJobStore } = await import("../tools/bash-background")
      const stopped: string[] = []
      const stoppedRuns: string[] = []
      const jobs = (
        await Promise.all(
          BashJobStore.running().map(async (job) =>
            job.planExecutionID === executionID && job.sessionID && (await Session.rootID(job.sessionID)) === rootID
              ? job
              : undefined,
          ),
        )
      ).filter((job) => job !== undefined)
      const runs = (await planWorkflows(rootID)).filter(
        (run) => run.planExecutionID === executionID && run.status === "running",
      )
      await Promise.all([
        ...jobs.map(async (job) => {
          try {
            await BashJobStore.stop(job.id, true)
          } catch (error) {
            log.warn("plan background stop unconfirmed", { rootID, error })
          }
          await BashJobStore.waitForStop(job.id)
          if (job.status === "stopped" && job.pausedForPlan) stopped.push(job.id)
        }),
        ...runs.map(async (run) => {
          await workflows.cancel(run.sessionID, run.runId)
          const result = (await workflows.list(run.sessionID)).find((item) => item.runId === run.runId)
          if (result?.status === "aborted") stoppedRuns.push(run.runId)
        }),
        ModeOperations.stopPlan(rootID, executionID),
      ])
      await SessionPlan.pause(rootID, executionID, stopped, stoppedRuns)
    })()
    planPauses().set(rootID, pending)
    void pending.then(
      () => {
        if (planPauses().get(rootID) === pending) planPauses().delete(rootID)
        unblock()
      },
      (error) => log.warn("plan pause unconfirmed", { rootID, error }),
    )
    return waitForPlanPause(pending, error)
  }
  async function planWorkStatus(sessionID: string, executionID: string) {
    try {
      const [runs, { BashJobStore }] = await Promise.all([planWorkflows(sessionID), import("../tools/bash-background")])
      const interrupted = await SessionPlan.interruptedWork(sessionID, executionID)
      const statuses = runs
        .filter((run) => run.planExecutionID === executionID && !interrupted?.workflows.includes(run.runId))
        .map((run) => run.status)
      for (const job of BashJobStore.list())
        if (
          job.planExecutionID === executionID &&
          !interrupted?.jobs.includes(job.id) &&
          job.sessionID &&
          (await Session.rootID(job.sessionID)) === sessionID
        )
          statuses.push(job.status)
      if (statuses.includes("running")) return "running"
      if (statuses.includes("failed")) return "failed"
      if (statuses.some((status) => status === "stopped" || status === "aborted")) return "stopped"
      return "completed"
    } catch (error) {
      log.warn("plan completion check failed", { sessionID, error })
      return "running"
    }
  }
  async function admittedPrompt(
    input: PromptInput,
    options?: { requireIdle?: boolean; planSource?: "button" | "chat" },
  ) {
    const text = input.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim()
    if (!startsSessionPlan(text)) return promptInternal(input, options)
    input = { ...input, sessionID: await Session.rootID(input.sessionID) }
    using _ = await Lock.write(`plan-start:${input.sessionID}`)
    const starts = planStarts()
    const known = starts.get(input.sessionID)
    if (known) {
      if (!known.settled) return known.promise
      const plan = await SessionPlan.get(input.sessionID)
      if (plan.status === "executing") return known.promise
    }
    input = { ...input, messageID: input.messageID ?? Identifier.ascending("message") }
    planSources().set(input.messageID!, options?.planSource ?? "chat")
    const running = SessionPlan.queue(input.sessionID, input.messageID!).then(() => promptInternal(input, options))
    const entry = { promise: running, settled: false }
    starts.set(input.sessionID, entry)
    void running
      .finally(async () => {
        entry.settled = true
        await SessionPlan.dequeue(input.sessionID, input.messageID!)
        planSources().delete(input.messageID!)
        const plan = await SessionPlan.get(input.sessionID).catch(() => undefined)
        if (plan?.status !== "executing" && plan?.status !== "paused" && starts.get(input.sessionID) === entry)
          starts.delete(input.sessionID)
      })
      .catch(() => {})
    return running
  }
  export const prompt = fn(PromptInput, async (input) => Message.native(await admittedPrompt(publicPromptInput(input))))
  export const promptWhenIdle = fn(PromptInput, async (input) =>
    Message.native(await admittedPrompt(publicPromptInput(input), { requireIdle: true })),
  )
  export async function startPlan(sessionID: string, selection: Pick<PromptInput, "model" | "variant"> = {}) {
    return admittedPrompt(
      {
        ...selection,
        sessionID: await Session.rootID(sessionID),
        parts: [{ type: "text", text: "Execute the latest saved session plan." }],
      },
      { planSource: "button" },
    )
  }
  // Engine-generated memory/dream prompts keep synthetic; not exposed through HTTP or the SDK.
  export const promptGenerated = fn(PromptInput, async (input) =>
    Message.native(
      await promptInternal({
        ...input,
        noReply: input.noReply || (await planPaused(input.sessionID)),
      }),
    ),
  )
  /**
   * Persists a whole-turn refusal as an assistant message without going through loop().
   * The reason and wording belong to the refusing plugin (`message`); the engine only uses a neutral fallback when
   * the plugin provides none.
   */
  const GENERIC_REFUSAL_MESSAGE = {
    zh: "抱歉，这个请求已被安全策略拒绝。",
    en: "Sorry, this request was blocked by the security policy.",
  }

  async function createRefusal(input: { user: Message.UserInfo; agent: string; message?: string }) {
    LoopExecution.check(input.user.sessionID)
    const text = input.message ?? (await LoopExecution.wait(() => Text.pick(GENERIC_REFUSAL_MESSAGE)))
    const now = Date.now()
    const info = (await LoopExecution.wait(async () =>
      Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "assistant",
        parentID: input.user.id,
        sessionID: input.user.sessionID,
        mode: input.agent,
        agent: input.agent,
        variant: input.user.variant,
        path: {
          cwd: Instance.directory,
          root: Instance.worktree,
        },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: input.user.model.modelID,
        providerID: input.user.model.providerID,
        time: {
          created: now,
          completed: now,
        },
        finish: "stop",
      }),
    )) as Message.AssistantInfo
    const part = await LoopExecution.wait(async () =>
      Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: info.id,
        sessionID: info.sessionID,
        type: "text",
        text,
      }),
    )
    // This path skips loop() and its deferred cancel, so finish manually; otherwise the client's optimistic busy state
    // never resets and the thinking animation keeps spinning.
    finishSyncCommand(info.sessionID)
    return { info, parts: [part] }
  }

  export async function resolvePromptParts(template: string): Promise<PromptInput["parts"]> {
    LoopExecution.check()
    const parts: PromptInput["parts"] = [
      {
        type: "text",
        text: template,
      },
    ]
    const files = ConfigMarkdown.files(template)
    const seen = new Set<string>()
    await LoopExecution.wait(async () =>
      Promise.all(
        files.map(async (match) => {
          const name = match[1]
          if (seen.has(name)) return
          seen.add(name)
          const filepath = name.startsWith("~/")
            ? path.join(os.homedir(), name.slice(2))
            : path.resolve(Instance.worktree, name)

          const stats = await LoopExecution.wait(async () => fs.stat(filepath).catch(() => undefined))
          if (!stats) {
            const agent = await LoopExecution.wait(async () => Agent.get(name))
            if (agent) {
              parts.push({
                type: "agent",
                name: agent.id,
              })
            }
            return
          }

          if (stats.isDirectory()) {
            parts.push({
              type: "file",
              url: pathToFileURL(filepath).href,
              filename: name,
              mime: "application/x-directory",
            })
            return
          }

          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: "text/plain",
          })
        }),
      ),
    )
    return parts
  }

  function start(sessionID: string) {
    const s = state()
    if (s[sessionID]) return undefined
    const releaseCheckout = Checkout.hold()
    const controller = new AbortController()
    s[sessionID] = {
      abort: controller,
      toolAborts: new Map(),
      callbacks: [],
      queuedPrompts: [],
      done: makeDone(),
      releaseCheckout,
    }
    // Return the controller rather than its signal: the loop checks identity on its deferred cancel, so an old loop
    // exiting does not kill a new loop started by notification delivery (which produced two "interrupted" messages).
    return controller
  }

  export function resume(sessionID: string) {
    const s = state()
    if (!s[sessionID]) return

    return s[sessionID].abort.signal
  }

  function releaseOwner(sessionID: string, controller: AbortController) {
    const s = state()
    if (s[sessionID]?.abort !== controller) return
    const queued = s[sessionID]?.callbacks ?? []
    const queuedPrompts = s[sessionID]?.queuedPrompts ?? []
    delete s[sessionID]
    for (const q of queued) {
      q.reject(new Message.AbortedError({ message: "Session loop ended" }))
    }
    for (const q of queuedPrompts) {
      q.reject(new Message.AbortedError({ message: "Session loop ended" }))
    }
    LoopStatus.set(sessionID, { type: "idle" })
    void PermissionNext.abortPending(sessionID)
    void Question.abortPending(sessionID)
  }

  export function cancel(sessionID: string, owner?: AbortController) {
    if (owner && state()[sessionID]?.abort !== owner) return
    log.info("cancel", { sessionID })
    for (const admission of admissions().get(sessionID) ?? [])
      admission.abort(new Message.AbortedError({ message: "Operation aborted by user" }))
    admissions().delete(sessionID)
    const s = state()
    const match = s[sessionID]
    const queuedMessages =
      match?.queuedPrompts.filter((queued) => queued.scope && queued.message).map((queued) => queued.message!) ?? []
    if (match) {
      match.abort.abort()
      // Internal request scopes reject on cancellation. A local Runner caller
      // already executing a turn retains the historical aborted-message result.
      if (match.activeCallback?.scope) {
        match.activeCallback.reject(new Message.AbortedError({ message: "Operation aborted by user" }))
      }
      for (const q of match.callbacks) {
        q.reject(new Message.AbortedError({ message: "Operation aborted by user" }))
      }
      match.callbacks = []
      for (const q of match.queuedPrompts) {
        q.reject(new Message.AbortedError({ message: "Operation aborted by user" }))
      }
      match.queuedPrompts = []
      delete s[sessionID]
      // Publish the abort before idle so the desktop can suppress its "reply ready" notice; if idle arrived first,
      // the suppression window would not be marked yet.
      Bus.publish(Session.Event.Error, {
        sessionID,
        error: new Message.AbortedError({ message: "Operation aborted by user" }).toObject(),
      })
    }
    LoopStatus.set(sessionID, { type: "idle" })
    // Stopping must clear pending permission and question requests, or the confirmation bar stays open.
    void PermissionNext.abortPending(sessionID)
    void Question.abortPending(sessionID)
    if (!match) return

    // A cancelled child session must also update the subagent tool part in its parent, or the side panel shows
    // "completed" instead of "terminated".
    const reconciliation = (async () => {
      try {
        for (const message of queuedMessages) await settleCancelledPrompt(message)
        const session = await Session.get(sessionID)
        const parentID = session?.parentID

        // Mark unfinished tool parts as errors. Persist only; no events are published.
        const abort = (part: Message.ToolPart) => {
          const now = Date.now()
          const time =
            part.state.status === "running" && "time" in part.state
              ? { start: part.state.time.start, end: now }
              : { start: now, end: now }
          return Transcript.part({
            ...part,
            state: {
              ...part.state,
              status: "error" as const,
              error: "Tool execution aborted",
              time,
            } as Message.ToolStateError,
          })
        }
        const unfinished = (part: Message.Part): part is Message.ToolPart =>
          part.type === "tool" && part.state.status !== "completed" && part.state.status !== "error"

        for await (const msg of Message.stream(sessionID)) {
          for (const part of msg.parts.filter(unfinished)) await abort(part)
        }

        if (parentID) {
          for await (const msg of Message.stream(parentID)) {
            const part = msg.parts
              .filter(unfinished)
              .find((item) => item.tool === "subagent" && (item.state as any).metadata?.sessionId === sessionID)
            if (part) await abort(part)
          }
        }
      } catch {
        // ignore
      }
    })()
    reconciliations().set(sessionID, reconciliation)
    void reconciliation.finally(() => {
      if (reconciliations().get(sessionID) === reconciliation) reconciliations().delete(sessionID)
    })

    return reconciliation
  }

  /**
   * Hard-stops the whole session tree: this session, its active workflow runs, its running background bash jobs and
   * all child sessions recursively. Undo (SessionUndoRedo.undo) calls it before touching files so assertNotBusy passes
   * and no background task keeps editing files after the rollback. Orchestration lives in cancel-tree.ts.
   * WorkflowState / BashJobStore are imported dynamically to avoid circular dependencies.
   */
  export async function cancelAndSettle(sessionID: string) {
    // Capture the owner before cancel removes its entry. Wait for its normal
    // settlement before ACK, subject to awaitLoopStopped's 3s safety limit.
    const done = state()[sessionID]?.done?.promise
    cancel(sessionID)
    await Promise.all([awaitLoopStopped(done), reconciliations().get(sessionID)])
  }

  /** Interrupt only the active turn, preserving accepted prompts for FIFO execution. */
  export async function interruptAndSettle(sessionID: string, requestIDs?: readonly string[]) {
    const previous = state()[sessionID]
    if (!previous) {
      const scope = LoopExecution.select(sessionID, requestIDs)
      if (scope) await LoopExecution.cancel(sessionID, [scope.id])
      return
    }

    const current = previous.activeCallback?.scope ?? previous.callbacks[0]?.scope
    const scope = current && LoopExecution.select(sessionID, requestIDs, current)
    // An old snapshot must not interrupt a new owner, nor a reserved FIFO owner
    // which is still waiting for the previous turn's real settlement.
    if (requestIDs && !scope) return
    previous.activeCallback?.reject(new Message.AbortedError({ message: "Operation aborted by user" }))

    const queued = previous.queuedPrompts
    previous.queuedPrompts = []
    // An interrupt keeps accepted input: prompts still being enqueued must survive the cancel below, which removes
    // admissions synchronously.
    const admitting = admissions().get(sessionID)
    admissions().delete(sessionID)
    const stopped = cancelAndSettle(sessionID)
    if (admitting) admissions().set(sessionID, admitting)
    const scoped = scope ? LoopExecution.cancel(sessionID, [scope.id]) : Promise.resolve()
    const reconciliation = reconciliations().get(sessionID)

    // Reserve the next owner before yielding. New input must join the same queue
    // while the aborted owner is still settling, rather than start another loop.
    const controller = start(sessionID)!
    const self = state()[sessionID]
    self.queuedPrompts = queued
    self.running = true
    LoopStatus.set(sessionID, { type: "busy" })
    log.info("prompt queue retained after interrupt", { sessionID, count: queued.length })

    void LoopExecution.run(undefined, async () => {
      // Cancellation ACK has a bounded wait; queue execution requires actual
      // settlement so an old tool or processor cannot overlap the next turn.
      await Promise.all([previous.done.promise, reconciliation])
      if (controller.signal.aborted || state()[sessionID] !== self) {
        self.done.resolve()
        self.releaseCheckout()
        return
      }
      if (!self.queuedPrompts.length) {
        self.done.resolve()
        self.releaseCheckout()
        releaseOwner(sessionID, controller)
        return
      }
      LoopStatus.set(sessionID, { type: "busy" })
      log.info("prompt queue resumed after interrupt", { sessionID, count: self.queuedPrompts.length })
      await processSessionTurns({ sessionID, controller, self })
    })

    await Promise.all([stopped, scoped])
  }

  export async function cancelTree(sessionID: string) {
    const { BashJobStore } = await import("../tools/bash-background")
    await cancelSessionTree(sessionID, {
      cancelSelf: async (id) => {
        state()[id]?.activeCallback?.reject(new Message.AbortedError({ message: "Operation aborted by user" }))
        const scoped = LoopExecution.cancel(id)
        await Promise.all([cancelAndSettle(id), scoped])
      },
      listWorkflowRuns: (id) => workflows.list(id),
      cancelWorkflowRun: (id, runId) => workflows.cancel(id, runId),
      listBashJobs: () => BashJobStore.list(),
      stopBashJob: (id) => BashJobStore.stop(id),
      listChildren: (id) => Session.children(id),
    })
  }

  export function cancelTool(sessionID: string, callID: string): boolean {
    const match = state()[sessionID]
    if (!match) return false
    const controller = match.toolAborts.get(callID)
    if (!controller) return false
    controller.abort()
    return true
  }

  export const LoopInput = z.object({
    sessionID: Identifier.schema("session"),
    resume_existing: z.boolean().optional(),
    permissionLevel: PermissionLevel.Schema.optional(),
    permissionMode: z
      .enum(["readonly", "ask"])
      .optional()
      .describe("Deprecated mode input; legacy auto must be explicitly reauthorized through permissionLevel."),
    /** @deprecated Use permissionLevel. */
    kind: PermissionLevel.Schema.optional(),
    /** Max loop turns for a forked child session, so extraction/notes agents cannot burn tokens. */
    maxTurns: z.number().optional(),
  })
  /** Filters messages for the target user message, excluding later queued user messages and their unsettled replies. */
  function filterMessagesForTargetUser(messages: Message.FullMsg[], targetUserID: string, turnUserIDs: Set<string>) {
    return messages.filter((m) => {
      if (turnUserIDs.has(m.info.id)) return true
      if (m.info.role === "user") {
        return m.info.id < targetUserID
      }
      if (m.info.role === "assistant") {
        const assistantInfo = m.info as Message.AssistantInfo
        return assistantInfo.parentID
          ? assistantInfo.parentID <= targetUserID || turnUserIDs.has(assistantInfo.parentID)
          : m.info.id < targetUserID
      }
      return false
    })
  }

  /** Finds the first user message that has not been answered yet. */
  function findNextUnansweredUser(messages: Message.FullMsg[]): Message.FullMsg | undefined {
    const completedUserIDs = new Set<string>()
    for (const m of messages) {
      if (Message.isExternal(m.info)) continue
      if (m.info.role !== "assistant") continue
      const info = m.info as Message.AssistantInfo
      if (!info.parentID) continue
      if ((info.finish && !["tool-calls", "unknown"].includes(info.finish)) || Boolean(info.error)) {
        completedUserIDs.add(info.parentID)
      }
    }

    for (const m of messages) {
      if (Message.isExternal(m.info)) continue
      if (m.info.role === "user" && !completedUserIDs.has(m.info.id)) {
        return m
      }
    }
    return undefined
  }

  type RunTurnInput = {
    sessionID: string
    targetUserID: string
    abort: AbortSignal
    loopPermissionLevel?: PermissionLevel.Value
    maxTurns?: number
  }

  async function runTurn(input: RunTurnInput): Promise<Message.FullMsg> {
    const { sessionID, targetUserID, abort, loopPermissionLevel, maxTurns } = input
    // Structured retries belong to this turn even when a later user prompt is
    // already queued. Keep that prompt outside the current model context.
    const turnUserIDs = new Set([targetUserID])
    // Structured output state
    // Note: On session resumption, state is reset but outputFormat is preserved
    // on the user message and will be retrieved from lastUserInfo below
    let structuredOutput: unknown | undefined
    // Times the model finished without calling StructuredOutput; drives the retryCount retries.
    let structuredAttempts = 0

    let step = 0
    const session = await Session.get(sessionID)
    const requested = await Message.get({ sessionID, messageID: targetUserID })
    const startText = requested.info.role === "user" ? Message.userSourceTexts(requested).join("\n").trim() : ""
    if (!session.parentID && startText) await SessionPlan.beginTurn(sessionID, targetUserID)
    const startingPlan = !session.parentID && startsSessionPlan(startText)
    let executionRequestDispatched = false
    let planCompactionAttempted = false
    const discoveredSkillNames = new Set<string>()
    const consumedSkillDiscoveryTriggerIDs = new Set<string>()
    let skillPrefetch: SkillDiscoveryPrefetch | undefined
    /**
     * Memory recall prefetch, fired once per user turn. The query does not change across steps, so create() runs only
     * when user.id changes and the handle is cleared after use; this avoids duplicate requests and dangling promises.
     * Failures resolve to undefined and part() falls back inline.
     */
    let memoryPrefetch: { userID: string; promise: Promise<MemoryRecall.Attachment | undefined> } | undefined
    while (true) {
      if (maxTurns && step >= maxTurns) break
      log.info("loop", { step, sessionID, targetUserID })
      if (abort.aborted) break

      // Keep only the messages after the most recent compaction boundary.
      let msgs = await Message.filterCompacted(Message.stream(sessionID))
      msgs = await consumeSessionNotifications({ sessionID, messages: msgs })
      msgs = SessionContextLayer.sortByTurnCausality(filterMessagesForTargetUser(msgs, targetUserID, turnUserIDs))

      let lastUserInfo: Message.UserInfo | undefined
      let lastUserMessage: Message.FullMsg | undefined
      let lastAssistantInfo: Message.AssistantInfo | undefined
      let lastFinishedInfo: Message.AssistantInfo | undefined
      let tasks: (Message.CompactionPart | Message.SubtaskPart)[] = []
      const failedCompactions = new Set(
        msgs
          .filter(
            (msg) =>
              !Message.isExternal(msg.info) &&
              msg.info.role === "assistant" &&
              msg.info.summary === true &&
              Boolean(msg.info.error),
          )
          .map((msg) => (msg.info as Message.AssistantInfo).parentID),
      )
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]
        if (Message.isExternal(msg.info)) continue
        if (!lastUserInfo && msg.info.role === "user") {
          lastUserInfo = msg.info as Message.UserInfo
          lastUserMessage = msg
        }
        if (!lastAssistantInfo && msg.info.role === "assistant") lastAssistantInfo = msg.info as Message.AssistantInfo
        if (!lastFinishedInfo && msg.info.role === "assistant" && msg.info.finish)
          lastFinishedInfo = msg.info as Message.AssistantInfo
        if (lastUserInfo && lastFinishedInfo) break
        const task = msg.parts.filter(
          (part): part is Message.CompactionPart | Message.SubtaskPart =>
            (part.type === "compaction" && !failedCompactions.has(msg.info.id)) || part.type === "subtask",
        )
        if (task && !lastFinishedInfo) {
          tasks.push(...task)
        }
      }

      if (!lastUserInfo) throw new Error("No user message found in stream. This should never happen.")
      // The session permission mode is the source of truth and is re-read every turn, so a live setMode
      // updates the next turn's tool pool and rules. Within a turn, liveExecution re-reads the session before each
      // tool call, so the ruleset and ctx.permissionLevel share one source.
      const effectivePermissionLevel = await modeOf(
        (await Session.get(sessionID).catch(() => undefined)) ?? session,
        loopPermissionLevel ?? lastUserInfo.permissionLevel,
      )
      // User interrupt (ESC): on abort the processor writes only error (MessageAbortedError), not finish. Without this
      // check a new loop would treat the interrupted turn as unfinished and call the LLM again, so the model keeps
      // working after ESC. See shouldExitLoop.
      if (shouldExitLoop(lastAssistantInfo, lastUserInfo?.id)) {
        log.info("exiting loop", { sessionID })
        // Schedule memory work here too: a normal finish=stop turn (plain text reply, no tool returning stop:true)
        // exits through shouldExitLoop after the processor returned "continue", so it would skip the result === "stop"
        // branch below. On AbortedError assistant.error is set and schedule skips itself.
        if (lastAssistantInfo && lastUserInfo) {
          scheduleTurnCompletion({
            session,
            assistant: lastAssistantInfo,
            model: lastUserInfo.model,
            tokens: tokensFromUsage(lastAssistantInfo.tokens),
          })
        }
        break
      }

      // Set busy only after confirming this turn will not exit immediately. Otherwise, after an ESC-interrupted turn, a
      // loop started by the notification deliverer would emit a busy pulse and break at once, making the client's
      // thinking animation mount and unmount (flicker). The immediate-exit path only emits idle. See shouldExitLoop.
      LoopStatus.set(sessionID, { type: "busy" })

      step++
      if (step === 1) {
        await SessionTitle.ensure({
          session,
          modelID: lastUserInfo.model.modelID,
          providerID: lastUserInfo.model.providerID,
          history: msgs,
        }).catch((err) => log.error("failed to generate title", { error: err }))
      }

      const model = await Provider.getModel(lastUserInfo.model.providerID, lastUserInfo.model.modelID).catch((e) => {
        publishProviderError(sessionID, e)
        throw e
      })
      const pendingTask = tasks.pop()

      // pending subtask
      // TODO: centralize "invoke tool" logic
      if (pendingTask?.type === "subtask") {
        const subagentTool = await SubAgentTool.init()
        const subagentModel = pendingTask.model
          ? await Provider.getModel(pendingTask.model.providerID, pendingTask.model.modelID)
          : model
        const assistantInfo = (await Session.updateInfo({
          id: Identifier.ascending("message"),
          role: "assistant",
          parentID: lastUserInfo.id,
          sessionID,
          mode: pendingTask.agent,
          agent: pendingTask.agent,
          variant: lastUserInfo.variant,
          path: {
            cwd: Instance.directory,
            root: Instance.worktree,
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: subagentModel.id,
          providerID: subagentModel.providerID,
          time: {
            created: Date.now(),
          },
        })) as Message.AssistantInfo
        let part = (await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistantInfo.id,
          sessionID: assistantInfo.sessionID,
          type: "tool",
          callID: ulid(),
          tool: SubAgentTool.id,
          state: {
            status: "running",
            input: {
              prompt: pendingTask.prompt,
              description: pendingTask.description,
              subagent_type: pendingTask.agent,
              command: pendingTask.command,
              mode: "fresh",
            },
            time: {
              start: Date.now(),
            },
          },
        })) as Message.ToolPart
        // Subagents started from a SubtaskPart always use a fresh context: slash command and @ subtasks do not need the
        // main conversation, and passing mode explicitly keeps "fresh" visible to plugin hooks.
        const subagentArgs = {
          prompt: pendingTask.prompt,
          description: pendingTask.description,
          subagent_type: pendingTask.agent,
          command: pendingTask.command,
          mode: "fresh" as const,
        }
        let executionError: Error | undefined
        // If the gate hook rejects, the subtask does not run and the !result branch below marks the card as an error,
        // the same as a rejected tool call.
        const rejected = await Plugin.trigger(
          "tool.execute.before",
          {
            tool: SubAgentTool.id,
            sessionID,
            callID: part.id,
          },
          { args: subagentArgs },
        ).then(
          () => false,
          (error) => {
            executionError = error
            return true
          },
        )
        const subagentRuleset = async () =>
          buildToolExecutionRuleset({
            agent: await Agent.get(lastUserInfo.agent),
            session: await Session.get(sessionID),
          })
        const subagentCtx: Tool.Context = {
          agent: pendingTask.agent,
          permissionLevel: effectivePermissionLevel,
          kind: effectivePermissionLevel,
          messageID: assistantInfo.id,
          sessionID: sessionID,
          abort,
          callID: part.callID,
          extra: { bypassAgentCheck: true },
          messages: msgs,
          ruleset: await subagentRuleset(),
          async metadata(input) {
            await Session.updatePart({
              ...part,
              type: "tool",
              state: {
                ...part.state,
                ...input,
              },
            } satisfies Message.ToolPart)
          },
          async ask(req) {
            return PermissionNext.askCurrent(
              {
                ...req,
                sessionID,
                tool: { messageID: assistantInfo.id, callID: part.callID },
              },
              subagentRuleset,
              abort,
            )
          },
        }
        const result = rejected
          ? undefined
          : await subagentTool.execute(subagentArgs, subagentCtx).catch((error) => {
              executionError = error
              log.error("subagent execution failed", {
                error,
                agent: pendingTask.agent,
                description: pendingTask.description,
              })
              return undefined
            })
        if (!rejected)
          await Plugin.trigger(
            "tool.execute.after",
            {
              tool: SubAgentTool.id,
              sessionID,
              callID: part.id,
              args: subagentArgs,
            },
            result,
          )
        assistantInfo.finish = "tool-calls"
        assistantInfo.time.completed = Date.now()
        await Session.updateInfo(assistantInfo)
        if (result && part.state.status === "running") {
          await Session.updatePart({
            ...part,
            state: {
              status: "completed",
              input: part.state.input,
              title: result.title,
              metadata: result.metadata,
              output: result.output,
              attachments: result.attachments,
              time: {
                ...part.state.time,
                end: Date.now(),
              },
            },
          } satisfies Message.ToolPart)
        }
        if (!result) {
          await Session.updatePart({
            ...part,
            state: {
              status: "error",
              error: executionError ? `Tool execution failed: ${executionError.message}` : "Tool execution failed",
              time: {
                start: part.state.status === "running" ? part.state.time.start : Date.now(),
                end: Date.now(),
              },
              metadata: part.metadata,
              input: part.state.input,
            },
          } satisfies Message.ToolPart)
        }

        if (pendingTask.command) {
          // Add synthetic user message to prevent certain reasoning models from erroring
          // If we create assistant messages w/ out user ones following mid loop thinking signatures
          // will be missing and it can cause errors for models like gemini for example
          const summaryUserInfo: Message.UserInfo = {
            id: Identifier.ascending("message"),
            sessionID,
            role: "user",
            time: {
              created: Date.now(),
            },
            agent: lastUserInfo.agent,
            model: lastUserInfo.model,
          }
          await Session.updateInfo(summaryUserInfo)
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: summaryUserInfo.id,
            sessionID,
            type: "text",
            text: "Summarize the subagent tool output above and continue with your task.",
            synthetic: true,
            metadata: { taskOriginMessageID: lastUserInfo.id },
          } satisfies Message.TextPart)
        }

        continue
      }

      // pending compaction
      if (pendingTask?.type === "compaction") {
        const result = await SessionCompaction.process({
          messages: msgs,
          parentID: lastUserInfo.id,
          abort,
          sessionID,
          auto: pendingTask.auto,
          onContinuation: (messageID) => turnUserIDs.add(messageID),
        })
        if (result === "stop") break
        continue
      }

      // context overflow, needs compaction
      if (lastFinishedInfo && lastFinishedInfo.summary !== true) {
        // No precise view exists yet, so use the previous turn's real usage. Once the breaker trips this only prunes
        // and never reports blocked here (the old usage does not shrink after pruning); the preempt check below
        // re-evaluates precisely.
        const action = await handleAutoCompaction({
          sessionID,
          agent: lastUserInfo.agent,
          model,
          tokens: tokensFromUsage(lastFinishedInfo.tokens),
          precise: false,
          reestimate: async () => tokensFromUsage(lastFinishedInfo.tokens),
          permissionLevel: effectivePermissionLevel,
        })
        if (action === "blocked") break
        if (action !== "skip") continue
      }

      // normal processing
      const agent = await Agent.get(lastUserInfo.agent)
      const maxSteps = agent.steps ?? Infinity
      const isLastStep = step >= maxSteps

      // Check if user explicitly invoked an agent via @ in this turn
      const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
      const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false

      // Memory recall prefetch runs once per turn: later steps of the same turn reuse the promise, since the query is
      // unchanged and a new request (possibly with an LLM rerank) would be wasted. It runs in parallel with skill
      // discovery and the context view build so part() does not block.
      if (!memoryPrefetch || memoryPrefetch.userID !== lastUserInfo.id) {
        // Recall is off by default; only memory.auto_recall=true starts create().
        const recallEnabled = await MemoryRecall.enabled()
        memoryPrefetch = {
          userID: lastUserInfo.id,
          promise: recallEnabled
            ? MemoryRecall.create({ messages: msgs, user: lastUserInfo }).catch(() => undefined)
            : Promise.resolve(undefined),
        }
      }

      const format = lastUserInfo.format ?? { type: "text" }
      const discoveryTrigger = skillToolAvailable({ agent, user: lastUserInfo })
        ? skillDiscoveryTrigger({
            step,
            messages: msgs,
            user: lastUserInfo,
            consumed: consumedSkillDiscoveryTriggerIDs,
          })
        : undefined
      const activeSkillPrefetch = skillPrefetch?.trigger.id === discoveryTrigger?.id ? skillPrefetch : undefined
      if (skillPrefetch && !activeSkillPrefetch) {
        skillPrefetch = undefined
      }
      const skillAttachment = await resolveSkillDiscoveryAttachment({
        prefetch: activeSkillPrefetch,
        trigger: discoveryTrigger,
        messages: msgs,
        agent,
        session,
        user: lastUserInfo,
        permissionLevel: effectivePermissionLevel,
        discovered: discoveredSkillNames,
      })
      if (activeSkillPrefetch) {
        skillPrefetch = undefined
      }
      const recalledMemoryPart = await MemoryRecall.part({
        messages: msgs,
        user: lastUserInfo,
        prefetch: memoryPrefetch?.promise,
      }).catch((error) => {
        log.warn("memory recall failed", { error })
        return undefined
      })
      const memoryPart = (() => {
        if (!recalledMemoryPart) return undefined
        const userMessage = msgs.find((msg) => msg.info.id === lastUserInfo.id && msg.info.role === "user")
        if (!userMessage) return undefined
        userMessage.parts.push(recalledMemoryPart)
        return recalledMemoryPart
      })()

      // Marker for the skill discovery suggestion. ignored=true keeps it out of toModelMessages (the `!part.ignored`
      // filter in message.ts) so it does not duplicate the content already injected via extraMessages; it only lets
      // hasMatchingSuggestion dedupe across turns.
      const skillDiscoveryPart = (() => {
        if (!skillAttachment) return undefined
        const userMessage = msgs.find((msg) => msg.info.id === lastUserInfo.id && msg.info.role === "user")
        if (!userMessage) return undefined
        const part: Message.TextPart = {
          id: Identifier.ascending("part"),
          messageID: lastUserInfo.id,
          sessionID,
          type: "text",
          text: skillAttachment.text,
          synthetic: true,
          ignored: true,
          metadata: SkillSearch.metadata(skillAttachment),
        }
        userMessage.parts.push(part)
        return part
      })()

      const preparation = await prepareTools({
        agent,
        model,
        session,
        tools: lastUserInfo.tools,
        messages: msgs,
        permissionLevel: effectivePermissionLevel,
        step,
      }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      const planForRequest = await SessionPlan.get(await Session.rootID(sessionID))
      const inheritedExecution = await SessionPlan.executionForMessage(sessionID, lastUserInfo.id)
      const planInput = SessionPlan.inputForTask(
        planForRequest,
        lastUserMessage ? Message.userSourceTexts(lastUserMessage).join("\n") : "",
        startingPlan,
        inheritedExecution,
      )
      const planExecution = startingPlan || !!planInput?.executionID
      const view = await SessionContextView.build({
        includePlan: startingPlan,
        planExecution,
        preparedTools: preparation.ok ? preparation.value : undefined,
        includeToolStats: preparation.ok,
        messages: msgs,
        sessionID,
        user: lastUserInfo,
        agent,
        model,
        step,
        lastFinishedID: lastFinishedInfo?.id,
        extraSystem: format.type === "json_schema" ? [STRUCTURED_OUTPUT_SYSTEM_PROMPT] : undefined,
        extraMessages: skillAttachment ? [skillAttachmentMessage(skillAttachment)] : undefined,
      })

      // Persist the memory and skill discovery parts before the preempt check: a compaction `continue` would skip
      // persistence, and the next filterCompacted read would lose this turn's memory and dedupe markers.
      if (memoryPart) {
        await Session.updatePart(memoryPart)
      }
      if (skillDiscoveryPart) {
        await Session.updatePart(skillDiscoveryPart)
      }

      if (lastFinishedInfo && lastFinishedInfo.summary !== true) {
        // Preemptive compaction. The view is built, so tokens can be re-estimated precisely and a tripped breaker can
        // report blocked.
        const action = await handleAutoCompaction({
          sessionID,
          agent: lastUserInfo.agent,
          model,
          tokens: view.tokens,
          precise: true,
          reestimate: async () => {
            const reestimated = await SessionContextView.build({
              planExecution,
              preparedTools: preparation.ok ? preparation.value : undefined,
              includeToolStats: preparation.ok,
              messages: await Message.filterCompacted(Message.stream(sessionID)),
              sessionID,
              user: lastUserInfo,
              agent,
              model,
              step,
              lastFinishedID: lastFinishedInfo?.id,
              extraSystem: format.type === "json_schema" ? [STRUCTURED_OUTPUT_SYSTEM_PROMPT] : undefined,
              extraMessages: skillAttachment ? [skillAttachmentMessage(skillAttachment)] : undefined,
            })
            return reestimated.tokens
          },
          permissionLevel: effectivePermissionLevel,
        })
        if (action === "blocked") break
        if (action !== "skip") continue
      }

      if (skillAttachment) {
        markDiscoveredSkills(skillAttachment, discoveredSkillNames)
        consumedSkillDiscoveryTriggerIDs.add(skillAttachment.triggerID ?? discoveryTrigger!.id)
      } else if (discoveryTrigger) {
        consumedSkillDiscoveryTriggerIDs.add(discoveryTrigger.id)
      }

      const processor = SessionProcessor.create({
        assistantInfo: (await Session.updateInfo({
          id: Identifier.ascending("message"),
          parentID: lastUserInfo.id,
          role: "assistant",
          mode: agent.id,
          agent: agent.id,
          variant: lastUserInfo.variant,
          path: {
            cwd: Instance.directory,
            root: Instance.worktree,
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: model.id,
          providerID: model.providerID,
          time: {
            created: Date.now(),
          },
          sessionID,
        })) as Message.AssistantInfo,
        sessionID: sessionID,
        model,
        abort,
      })
      using _ = defer(() => ContextAttach.clear(processor.message.id))

      const resolvedTools = await (
        preparation.ok
          ? resolveTools({
              planExecution,
              prepared: preparation.value,
              agent,
              session,
              model,
              tools: lastUserInfo.tools,
              processor,
              bypassAgentCheck,
              messages: msgs,
              permissionLevel: effectivePermissionLevel,
              step,
            })
          : Promise.reject(preparation.error)
      ).catch(async (error) => {
        log.error("failed to resolve tools", { sessionID, error })
        processor.message.error = Message.fromError(error, { providerID: model.providerID })
        processor.message.finish = "stop"
        processor.message.time.completed = Date.now()
        await Session.updateInfo(processor.message)
        Bus.publish(Session.Event.Error, {
          sessionID,
          error: processor.message.error,
        })
        return undefined
      })
      if (!resolvedTools) break
      const { tools, mcpIds, dynamicToolIds, autoActivated } = resolvedTools

      // Auto-activation marker. Activation state is derived from history (scanActivatedTools); without this part the
      // next turn would not see it and the tool would revert to deferred. Like the skill discovery marker it is
      // synthetic + ignored, so it stays out of the model context and only serves as a replay anchor; compaction
      // carries it in preCompactActivatedTools.
      if (autoActivated.length > 0) {
        const userMessage = msgs.find((msg) => msg.info.id === lastUserInfo.id && msg.info.role === "user")
        if (userMessage) {
          const part: Message.TextPart = {
            id: Identifier.ascending("part"),
            messageID: lastUserInfo.id,
            sessionID,
            type: "text",
            // The text is for humans only; replay relies on metadata.
            text: `[tool auto-activated] ${autoActivated.join(", ")}`,
            synthetic: true,
            ignored: true,
            metadata: autoActivationMetadata(autoActivated),
          }
          userMessage.parts.push(part)
          await Session.updatePart(part)
        }
      }

      // Inject StructuredOutput tool if JSON schema mode enabled
      if (lastUserInfo.format?.type === "json_schema") {
        tools["StructuredOutput"] = createStructuredOutputTool({
          schema: lastUserInfo.format.schema,
          onSuccess(output) {
            structuredOutput = output
          },
        })
      }

      if (step === 1) {
        SessionSummary.summarize({
          sessionID: sessionID,
          messageID: lastUserInfo.id,
        }).catch((err) => log.error("session summary failed", { error: err }))
      }

      let compactPlanRequest = false
      const result = await processor.process({
        user: lastUserInfo,
        agent,
        abort,
        sessionID,
        system: view.system,
        systemPrepared: true,
        systemBreakdown: view.systemBreakdown,
        messages: [
          ...view.messages,
          ...(isLastStep
            ? [
                {
                  role: "assistant" as const,
                  content: MAX_STEPS,
                },
              ]
            : []),
        ],
        tools,
        mcpToolIds: mcpIds,
        dynamicToolIds: dynamicToolIds,
        model,
        toolChoice: format.type === "json_schema" ? "required" : undefined,
        beforeRequest: async (request) => {
          const rootID = await Session.rootID(sessionID)
          const resumingPlan =
            !session.parentID &&
            planForRequest.status === "paused" &&
            resumesSessionPlan(
              Message.userSourceTexts(await Message.get({ sessionID, messageID: lastUserInfo.id })).join("\n"),
            )
          if (
            planPauses().has(rootID) ||
            ((executionRequestDispatched || (planExecution && !startingPlan && !resumingPlan)) &&
              (await planPaused(sessionID)))
          )
            throw new SessionPlan.PausedError({
              message: await Text.pick({
                zh: "计划执行已暂停。请明确恢复执行后再继续原任务。",
                en: "Plan execution is paused. Explicitly resume execution to continue the original task.",
              }),
            })
          const content = planInput?.content ?? ""
          if (!content.trim()) {
            if (startingPlan)
              await SessionPlan.start(sessionID, planSources().get(targetUserID) ?? "chat", planForRequest.revision)
            return
          }
          const capacity = await SessionCompaction.capacity(model)
          try {
            await PlanCapacity.assert({
              content,
              requestTokens: Token.estimateValue(request),
              availableTokens: capacity.usable,
            })
          } catch (error) {
            if (Message.PlanCapacityError.isInstance(error) && planInput?.executionID) {
              const rootID = await Session.rootID(sessionID)
              const paused = pausePlan(rootID, planInput.executionID, error)
              if (rootID === sessionID) await paused
              else void paused.catch((error) => log.warn("plan pause unconfirmed", { rootID, error }))
            }
            if (
              Message.PlanCapacityError.isInstance(error) &&
              !planCompactionAttempted &&
              Token.estimateValue(msgs.filter((message) => message.info.id !== lastUserInfo.id)) >= error.data.deficit
            ) {
              compactPlanRequest = true
              throw new Message.ContextOverflowError({
                message: "The plan request requires history compaction before dispatch.",
              })
            }
            throw error
          }
          if (startingPlan || resumingPlan)
            await SessionPlan.start(sessionID, planSources().get(targetUserID) ?? "chat", planForRequest.revision)
          if (planInput) await SessionPlan.assertInputCurrent(rootID, planInput)
          executionRequestDispatched ||= planExecution
        },
      })
      if (compactPlanRequest) {
        planCompactionAttempted = true
        turnUserIDs.add(
          await SessionCompaction.create({
            sessionID,
            agent: lastUserInfo.agent,
            model: lastUserInfo.model,
            permissionLevel: effectivePermissionLevel,
            auto: true,
          }),
        )
        continue
      }

      // If structured output was captured, save it and exit immediately
      // This takes priority because the StructuredOutput tool was called successfully
      if (structuredOutput !== undefined) {
        skillPrefetch = undefined
        processor.message.structured = structuredOutput
        processor.message.finish = processor.message.finish ?? "stop"
        await Session.updateInfo(processor.message)
        await ackSuccessfulNotificationTurn({ sessionID, user: lastUserMessage, assistant: processor.message })
        break
      }

      if (result === "continue" && processor.message.finish === "tool-calls" && !processor.message.error) {
        const parts = await Message.parts({ sessionID, messageID: processor.message.id })
        const current = {
          info: processor.message,
          parts,
        }
        skillPrefetch = startSkillDiscoveryPrefetch({
          enabled: tools.skill !== undefined,
          trigger: latestWritePivot([current]),
          messages: [...msgs, current],
          agent,
          session,
          user: lastUserInfo,
          permissionLevel: effectivePermissionLevel,
          discovered: discoveredSkillNames,
        })
      } else {
        skillPrefetch = undefined
      }

      // Check if model finished (finish reason is not "tool-calls" or "unknown")
      const modelFinished = processor.message.finish && !["tool-calls", "unknown"].includes(processor.message.finish)

      if (modelFinished && !processor.message.error) {
        if (format.type === "json_schema") {
          // Model stopped without calling StructuredOutput tool.
          structuredAttempts++
          if (shouldRetryStructuredOutput({ attempt: structuredAttempts, retryCount: format.retryCount })) {
            // Instead of failing right away, append a synthetic user message carrying the same format and retry. Its id
            // is not the previous assistant's parentID, so shouldExitLoop does not exit early, and the format makes the
            // next turn inject StructuredOutput again.
            processor.message.finish = processor.message.finish ?? "stop"
            await Session.updateInfo(processor.message)
            turnUserIDs.add(await enqueueStructuredRetry({ sessionID, lastUserInfo }))
            continue
          }
          // Retries exhausted: set an explicit error (retries is the number of retries attempted).
          processor.message.error = new Message.StructuredOutputError({
            message: "Model did not produce structured output",
            retries: Math.max(0, structuredAttempts - 1),
          }).toObject()
          await Session.updateInfo(processor.message)
          break
        }
        // Memory extraction is scheduled only when the turn ends, not on intermediate steps, to avoid forking a child
        // session on every step.
        await ackSuccessfulNotificationTurn({ sessionID, user: lastUserMessage, assistant: processor.message })
      }

      if (
        shouldStopUnknownFinish({
          assistant: processor.message,
          parts: await Message.parts({ sessionID, messageID: processor.message.id }),
        })
      ) {
        // Some OpenAI-compatible gateways end the stream without a standard stop. If the turn has text and no tool
        // calls, looping again would only repeat the request.
        processor.message.finish = "stop"
        await Session.updateInfo(processor.message)
        scheduleTurnCompletion({
          session,
          assistant: processor.message,
          model: lastUserInfo.model,
          tokens: tokensFromUsage(processor.message.tokens),
        })
        break
      }

      if (result === "stop") {
        // A tool may end the turn while the provider reports tool-calls. Persist the terminal state so the owner
        // queue does not treat this user message as unanswered and execute it again.
        if (processor.stoppedByTool && !processor.message.error) {
          processor.message.finish = "stop"
          await Session.updateInfo(processor.message)
        }
        // Schedule only for this terminal response; intermediate steps do not fork extraction sessions.
        scheduleTurnCompletion({
          session,
          assistant: processor.message,
          model: lastUserInfo.model,
          tokens: tokensFromUsage(processor.message.tokens),
        })
        break
      }
      if (result === "compact") {
        // The processor hit ContextOverflow mid-stream, pruned, and asks for compaction. If the breaker has tripped,
        // prune aggressively instead of forking a summary that will fail. There is no precise estimate here, so this
        // never reports blocked; the next preempt check re-evaluates.
        const action = await handleAutoCompaction({
          sessionID,
          agent: lastUserInfo.agent,
          model,
          tokens: tokensFromUsage(lastFinishedInfo?.tokens),
          precise: false,
          reestimate: async () => tokensFromUsage(lastFinishedInfo?.tokens),
          permissionLevel: effectivePermissionLevel,
        })
        if (action === "blocked") break
      }
      continue
    }
    // Not awaited; the session may be deleted before it finishes
    SessionCompaction.prune({ sessionID }).catch((error) => log.warn("prune failed", { sessionID, error }))
    for await (const item of Message.stream(sessionID)) {
      if (item.info.role === "assistant" && turnUserIDs.has(item.info.parentID)) {
        return item
      }
    }
    for await (const item of Message.stream(sessionID)) {
      if (item.info.role !== "user") return item
    }
    throw new Error("No assistant message found for completed turn")
  }

  function bindExecution(
    scope: LoopExecution.Scope | undefined,
    sessionID: string,
    controller: AbortController,
    self: LoopState,
  ) {
    return LoopExecution.bind(scope, {
      cancel: () => cancel(sessionID, controller),
      done: self.done.promise,
    })
  }

  // A cancelled queued message has already been persisted. Settle it without a
  // model call so a later loop cannot rediscover it as an unanswered request.
  function settleCancelledPrompt(message: Message.FullMsg): Promise<void> {
    if (message.info.role !== "user") return Promise.resolve()
    const pending = cancelledPromptSettlements().get(message.info.id)
    if (pending) return pending
    const settled = persistCancelledPrompt(message)
    cancelledPromptSettlements().set(message.info.id, settled)
    void settled.finally(() => cancelledPromptSettlements().delete(message.info.id)).catch(() => {})
    return settled
  }

  async function persistCancelledPrompt(message: Message.FullMsg) {
    if (message.info.role !== "user" || Message.isExternal(message.info)) return
    const user = message.info
    const messages = await Message.filterCompacted(Message.stream(user.sessionID))
    if (messages.some((item) => item.info.role === "assistant" && item.info.parentID === user.id)) return
    const now = Date.now()
    await Session.updateInfo({
      id: Identifier.ascending("message"),
      sessionID: user.sessionID,
      parentID: user.id,
      role: "assistant",
      mode: user.agent,
      agent: user.agent,
      path: { cwd: Instance.directory, root: Instance.worktree },
      modelID: user.model.modelID,
      providerID: user.model.providerID,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      error: new Message.AbortedError({ message: "Operation aborted before execution" }).toObject(),
      time: { created: now, completed: now },
    })
  }

  async function processSessionTurns(input: {
    sessionID: string
    controller: AbortController
    self: LoopState
    loopPermissionLevel?: PermissionLevel.Value
    maxTurns?: number
  }) {
    const { sessionID, controller, self, loopPermissionLevel, maxTurns } = input
    const abort = controller.signal
    let unbind = () => {}
    let completed: { callback: TurnCallback; result: Message.FullMsg } | undefined
    let turn: { messageID: string; result?: Message.FullMsg; failed?: boolean } | undefined
    let execution: { id: string; failed: boolean } | undefined

    async function recordPlanTurn() {
      if (!turn || !(await SessionPlan.executionForMessage(sessionID, turn.messageID))) return
      const rootID = await Session.rootID(sessionID)
      if (rootID !== sessionID && resume(rootID)) return
      const plan = await SessionPlan.get(rootID)
      if (plan.status !== "executing" || !plan.execution || planPauses().has(rootID)) return
      execution = {
        id: plan.execution.id,
        failed: await SessionPlan.recordExecutionFailure(
          rootID,
          plan.execution.id,
          !abort.aborted && (!!turn.failed || !!(turn.result?.info.role === "assistant" && turn.result.info.error)),
        ),
      }
    }

    try {
      unbind = bindExecution(self.callbacks[0]?.scope, sessionID, controller, self)
      while (!abort.aborted) {
        const allMsgs = await Message.filterCompacted(Message.stream(sessionID))
        // With no unanswered or queued user message, check for pending notifications (e.g. a finished background
        // workflow) and turn one into a user message to keep going.
        let targetUser =
          findNextUnansweredUser(allMsgs) ??
          (self.queuedPrompts.length === 0
            ? findNextUnansweredUser(await consumeSessionNotifications({ sessionID, messages: allMsgs }))
            : undefined)

        if (targetUser) {
          const queueIndex = self.queuedPrompts.findIndex((q) => q.message && q.message.info.id === targetUser!.info.id)
          if (queueIndex !== -1) {
            const [matched] = self.queuedPrompts.splice(queueIndex, 1)
            if (matched.scope?.controller.signal.aborted) {
              await settleCancelledPrompt(matched.message!)
              matched.reject(matched.scope.controller.signal.reason)
              continue
            }
            self.callbacks.push({
              scope: matched.scope,
              resolve: matched.resolve,
              reject: matched.reject,
            })
          }
        } else {
          const nextPrompt = self.queuedPrompts.shift()
          if (nextPrompt) {
            try {
              nextPrompt.scope?.controller.signal.throwIfAborted()
              const msg =
                nextPrompt.message ??
                (await LoopExecution.run(nextPrompt.scope, () =>
                  prepareAndCreatePromptMessage(nextPrompt.input, nextPrompt.options),
                ))
              if (nextPrompt.input.noReply === true || msg.info.role === "assistant") {
                nextPrompt.resolve(msg)
                continue
              }
              self.callbacks.push({
                scope: nextPrompt.scope,
                resolve: nextPrompt.resolve,
                reject: nextPrompt.reject,
              })
              targetUser = msg
            } catch (err) {
              nextPrompt.reject(err)
              continue
            }
          } else {
            break
          }
        }

        // A successor keeps the owner busy. With no successor, resolve the last
        // result only after finally releases the owner and publishes idle.
        completed?.callback.resolve(completed.result)
        completed = undefined
        self.activeCallback = self.callbacks.shift()
        unbind()
        unbind = bindExecution(self.activeCallback?.scope, sessionID, controller, self)
        turn = { messageID: targetUser.info.id }
        const result = await LoopExecution.run(self.activeCallback?.scope, () =>
          runTurn({
            sessionID,
            targetUserID: targetUser.info.id,
            abort,
            loopPermissionLevel,
            maxTurns,
          }),
        )
        turn.result = result
        await recordPlanTurn()
        if (
          !SessionStore.find(sessionID)?.parentID &&
          result.info.role === "assistant" &&
          !result.info.error &&
          !abort.aborted
        )
          await SessionPlan.completeTurn(sessionID, targetUser.info.id)

        const cb = self.activeCallback
        self.activeCallback = undefined
        unbind()
        if (cb) {
          completed = { callback: cb, result }
        }
      }
    } catch (error) {
      if (turn) turn.failed = true
      log.error("processSessionTurns error", { sessionID, error })
      self.activeCallback?.reject(error)
      self.activeCallback = undefined
      const queued = self.callbacks
      self.callbacks = []
      for (const q of queued) {
        q.reject(error)
      }
      const queuedPrompts = self.queuedPrompts
      self.queuedPrompts = []
      for (const q of queuedPrompts) {
        q.reject(error)
      }
    } finally {
      unbind()
      try {
        await recordPlanTurn()
        const rootID = await Session.rootID(sessionID)
        const plan = rootID === sessionID || !resume(rootID) ? await SessionPlan.get(rootID) : undefined
        const work = execution ? await planWorkStatus(rootID, execution.id) : "running"
        // A later discussion cannot erase an execution result; background work still retains its fixed snapshot.
        if (
          execution &&
          plan?.status === "executing" &&
          plan.execution?.id === execution.id &&
          !planPauses().has(rootID) &&
          work !== "running"
        )
          await SessionPlan.setStatus(
            rootID,
            abort.aborted ? "stopped" : execution.failed ? "failed" : work,
            undefined,
            execution.id,
          )
      } catch (error) {
        log.warn("plan completion deferred", { sessionID, error })
      } finally {
        if (!abort.aborted && self.queuedPrompts.length > 0) {
          completed?.callback.resolve(completed.result)
          void processSessionTurns(input)
          return
        }
        self.running = false
        self.done.resolve()
        self.releaseCheckout()
        releaseOwner(sessionID, controller)
        completed?.callback.resolve(completed.result)
      }
    }
  }

  export const run = fn(LoopInput, async (input) => {
    const { sessionID, resume_existing } = input
    await SessionCrash.reconcile(sessionID, () => Boolean(resume(sessionID)))
    LoopExecution.check(sessionID)
    const scope = LoopExecution.current(sessionID)
    const loopPermissionLevel = input.permissionLevel ?? input.kind

    const controller = resume_existing ? undefined : start(sessionID)
    const self = state()[sessionID]

    if (controller && self) {
      self.running = true
      const ownerPromise = new Promise<Message.FullMsg>((resolve, reject) => {
        self.callbacks.push({ scope, resolve, reject })
      })

      void LoopExecution.run(undefined, () =>
        processSessionTurns({
          sessionID,
          controller,
          self,
          loopPermissionLevel,
          maxTurns: input.maxTurns,
        }),
      )

      return ownerPromise
    }

    if (!self) {
      throw new Error(`Cannot resume session ${sessionID}: session is not running`)
    }

    if (resume_existing && !self.running) {
      self.running = true
      const resumePromise = new Promise<Message.FullMsg>((resolve, reject) => {
        self.callbacks.push({ scope, resolve, reject })
      })

      void LoopExecution.run(undefined, () =>
        processSessionTurns({
          sessionID,
          controller: self.abort,
          self,
          loopPermissionLevel,
          maxTurns: input.maxTurns,
        }),
      )

      return resumePromise
    }

    return new Promise<Message.FullMsg>((resolve, reject) => {
      self.callbacks.push({ scope, resolve, reject })
    })
  })

  /**
   * @internal Structured output retry decision.
   * attempt: 1-based count of times the model finished without calling StructuredOutput, including this one.
   * retryCount: max retries set on the format (undefined means 0, no retry).
   * Retry while attempt <= retryCount; otherwise give up with StructuredOutputError.
   */
  export function shouldRetryStructuredOutput(input: { attempt: number; retryCount: number | undefined }): boolean {
    return input.attempt <= (input.retryCount ?? 0)
  }

  /**
   * Appends a synthetic user message carrying the original format so the loop retries structured output.
   * The format makes the next turn inject StructuredOutput again, and the text pushes the model to use the tool
   * instead of plain text.
   */
  async function enqueueStructuredRetry(input: { sessionID: string; lastUserInfo: Message.UserInfo }) {
    const retryUserInfo: Message.UserInfo = {
      ...input.lastUserInfo,
      id: Identifier.ascending("message"),
      time: { created: Date.now() },
    }
    await Session.updateInfo(retryUserInfo)
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: retryUserInfo.id,
      sessionID: input.sessionID,
      type: "text",
      text: [
        "You did not call the StructuredOutput tool.",
        "You MUST call the StructuredOutput tool now with your final answer as valid JSON matching the requested schema.",
        "Do NOT reply with plain text.",
      ].join(" "),
      synthetic: true,
      metadata: { taskOriginMessageID: input.lastUserInfo.id },
    } satisfies Message.TextPart)
    return retryUserInfo.id
  }

  /** @internal Exported for focused regression tests. */
  export function shouldStopUnknownFinish(input: { assistant: Message.AssistantInfo; parts: Message.Part[] }) {
    if (input.assistant.finish !== "unknown") return false
    if (input.assistant.error) return false
    const hasText = input.parts.some((part) => part.type === "text" && part.text.trim().length > 0)
    if (!hasText) return false
    return !input.parts.some((part) => part.type === "tool")
  }

  function skillToolAvailable(input: { agent: Agent.Info; user: Message.UserInfo }) {
    return standardToolAvailable({
      id: "skill",
      agent: input.agent,
      tools: input.user.tools,
    })
  }

  function standardToolAvailable(input: { id: string; agent: Agent.Info; tools?: Record<string, boolean> }) {
    if (input.tools?.[input.id] === false) return false
    return new Set(input.agent.profile?.availableTools ?? STANDARD_TOOL_POOL).has(input.id)
  }

  /** @internal Exported for focused regression tests. */
  export function skillDiscoveryTrigger(input: {
    step: number
    messages: Message.FullMsg[]
    user: Message.UserInfo
    consumed: Set<string>
  }): SkillDiscoveryTrigger | undefined {
    if (input.step === 1) {
      if (input.consumed.has(input.user.id)) return undefined
      return {
        id: input.user.id,
        kind: "user_message",
      }
    }

    const pivot = latestWritePivot(input.messages)
    if (!pivot || input.consumed.has(pivot.id)) return undefined
    return pivot
  }

  /** @internal Exported for focused regression tests. */
  export function latestWritePivot(messages: Message.FullMsg[]): SkillDiscoveryTrigger | undefined {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (message.info.role !== "assistant") continue

      const tools = message.parts.filter(
        (part): part is Message.ToolPart => part.type === "tool" && part.state.status === "completed",
      )
      if (tools.length === 0) continue
      return tools.some((part) => WRITE_PIVOT_TOOLS.has(part.tool))
        ? { id: message.info.id, kind: "write_pivot" }
        : undefined
    }
  }

  /** @internal Exported for focused regression tests. */
  export async function resolveSkillDiscoveryAttachment(input: {
    prefetch?: SkillDiscoveryPrefetch
    trigger?: SkillDiscoveryTrigger
    messages: Message.FullMsg[]
    agent: Agent.Info
    session: Session.Info
    user: Message.UserInfo
    /** Permission mode used to build the skill discovery ruleset. */
    permissionLevel?: PermissionLevel.Value
    discovered: Set<string>
  }) {
    if (!input.trigger || !skillToolAvailable(input)) return undefined

    const ruleset = buildToolExecutionRuleset({
      agent: input.agent,
      session: input.session,
      permissionLevel: input.permissionLevel,
    })
    const prefetchedAttachment = input.prefetch ? await input.prefetch.promise : undefined
    const prefetched = await filterSkillAttachment({
      attachment: prefetchedAttachment,
      trigger: input.trigger,
      messages: input.messages,
      agent: input.agent,
      ruleset,
      user: input.user,
      discovered: input.discovered,
    })
    if (prefetched) {
      // Dedupe across turns: skip if the same query and skill set was already suggested (marker part in history).
      return SkillSearch.hasMatchingSuggestion(input.messages, prefetched) ? undefined : prefetched
    }
    if (input.prefetch) return undefined

    const attachment = await SkillSearch.attachment({
      messages: input.messages,
      agent: input.agent,
      ruleset,
      exclude: input.discovered,
      messageID: input.user.id,
      triggerID: input.trigger.id,
    }).catch((error) => {
      log.warn("skill discovery attachment failed", { error })
      return undefined
    })
    if (!attachment) return undefined
    return SkillSearch.hasMatchingSuggestion(input.messages, attachment) ? undefined : attachment
  }

  /** @internal Exported for focused regression tests. */
  export function startSkillDiscoveryPrefetch(input: {
    enabled: boolean
    trigger?: SkillDiscoveryTrigger
    messages: Message.FullMsg[]
    agent: Agent.Info
    session: Session.Info
    user: Message.UserInfo
    /** Permission mode used to build the skill discovery ruleset. */
    permissionLevel?: PermissionLevel.Value
    discovered: Set<string>
  }) {
    if (!input.enabled || !input.trigger || input.trigger.kind !== "write_pivot" || !skillToolAvailable(input)) {
      return undefined
    }
    return {
      trigger: input.trigger,
      promise: SkillSearch.attachment({
        messages: input.messages,
        agent: input.agent,
        ruleset: buildToolExecutionRuleset({
          agent: input.agent,
          session: input.session,
          permissionLevel: input.permissionLevel,
        }),
        exclude: input.discovered,
        messageID: input.user.id,
        triggerID: input.trigger.id,
      }).catch((error) => {
        log.warn("skill discovery prefetch failed", { error })
        return undefined
      }),
    }
  }

  /** @internal Exported for focused regression tests. */
  export async function filterSkillAttachment(input: {
    attachment?: SkillSearch.Attachment
    trigger: SkillDiscoveryTrigger
    messages: Message.FullMsg[]
    agent: Agent.Info
    ruleset: PermissionNext.Ruleset
    user: Message.UserInfo
    discovered: Set<string>
  }) {
    if (!input.attachment) return undefined
    if (input.attachment.messageID && input.attachment.messageID !== input.user.id) return undefined
    if (!input.attachment.triggerID || input.attachment.triggerID !== input.trigger.id) return undefined

    const accessible = new Set(
      (
        await SkillSearch.accessible({
          skills: input.attachment.skills,
          agent: input.agent,
          ruleset: input.ruleset,
        })
      ).map((skill) => skill.name),
    )
    const loaded = SkillSearch.loadedSkillNames(input.messages)
    const skills = input.attachment.skills.filter(
      (skill) => accessible.has(skill.name) && !input.discovered.has(skill.name) && !loaded.has(skill.name),
    )
    if (skills.length === 0) return undefined

    return {
      ...input.attachment,
      skills,
      text: SkillSearch.renderAttachment(skills),
    }
  }

  function markDiscoveredSkills(attachment: SkillSearch.Attachment, discovered: Set<string>) {
    for (const skill of attachment.skills) {
      discovered.add(skill.name)
    }
  }

  function skillAttachmentMessage(attachment: SkillSearch.Attachment): ModelMessage {
    return {
      role: "user",
      content: [
        {
          type: "text",
          text: attachment.text,
        },
      ],
    }
  }

  /**
   * Token count from AssistantInfo.tokens for overflow checks.
   * Prefers total and falls back to input + output + reasoning + cache, so older messages without total do not
   * resolve to 0 and silently disable auto compaction.
   */
  function tokensFromUsage(tokens: Message.AssistantInfo["tokens"] | undefined): number {
    if (!tokens) return 0
    if (typeof tokens.total === "number") return tokens.total
    return (
      (tokens.input ?? 0) +
      (tokens.output ?? 0) +
      (tokens.reasoning ?? 0) +
      (tokens.cache?.read ?? 0) +
      (tokens.cache?.write ?? 0)
    )
  }

  /** Wraps a single token count in the tokens shape isOverflow expects. */
  function overflowTokens(tokens: number) {
    return {
      total: tokens,
      input: tokens,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    }
  }

  /**
   * Shared auto-compaction handling with the circuit breaker, used by all three trigger points.
   * - Not over capacity: "skip" (caller continues normally).
   * - Over and breaker not tripped: "compact" (summary requested, caller continues the loop).
   * - Over and breaker tripped: fallbackPrune frees tool output without an LLM call, then:
   *     - precise=true: re-estimate; still over returns "blocked" (error published, caller breaks), else "pruned".
   *     - precise=false: no view to re-estimate, so return "pruned" and let the loop reach the precise check
   *       (preempt) before deciding blocked, rather than judging from stale usage.
   *
   * Only the preempt check has a built view to re-estimate; the normal-flow and compact-result checks only have
   * lastFinishedInfo.tokens, which does not shrink after pruning, so they cannot report blocked.
   */
  async function handleAutoCompaction(input: {
    sessionID: string
    agent: string
    model: Provider.Model
    tokens: number
    precise?: boolean
    reestimate: () => Promise<number>
    // The turn that continues after compaction keeps the current permission mode.
    permissionLevel?: PermissionLevel.Value
  }): Promise<"compact" | "pruned" | "blocked" | "skip"> {
    if (!(await SessionCompaction.isOverflow({ model: input.model, tokens: overflowTokens(input.tokens) }))) {
      return "skip"
    }
    if (await SessionCompaction.isCompactionTripped(input.sessionID)) {
      log.info("compaction tripped, fallback prune", { sessionID: input.sessionID, tokens: input.tokens })
      await SessionCompaction.fallbackPrune({ sessionID: input.sessionID })
      if (input.precise) {
        const reestimated = await input.reestimate()
        if (await SessionCompaction.isOverflow({ model: input.model, tokens: overflowTokens(reestimated) })) {
          await SessionCompaction.tripBlockingLimit({
            sessionID: input.sessionID,
            tokens: reestimated,
            model: input.model,
          })
          return "blocked"
        }
      }
      return "pruned"
    }
    log.info("preempting request for compaction", {
      tokens: input.tokens,
      modelID: input.model.id,
      providerID: input.model.providerID,
    })
    await SessionCompaction.create({
      sessionID: input.sessionID,
      agent: input.agent,
      model: { providerID: input.model.providerID, modelID: input.model.id },
      permissionLevel: input.permissionLevel,
      auto: true,
    })
    return "compact"
  }

  async function lastModel(sessionID: string) {
    for await (const item of Message.stream(sessionID)) {
      if (!Message.isExternal(item.info) && item.info.role === "user" && item.info.model) return item.info.model
    }
    return Provider.defaultModel()
  }

  /** @internal Exported for tests and notification-driven loop resumption. */
  export async function consumeSessionNotifications(input: { sessionID: string; messages: Message.FullMsg[] }) {
    const messages = await ackDeliveredSessionNotifications(input)
    const notifications = await SessionNotification.list(input.sessionID)
    if (notifications.length === 0) return messages

    const latestRealUser = messages.findLast(
      (message): message is Message.FullMsg & { info: Message.UserInfo } =>
        message.info.role === "user" && !isNotificationUser(message),
    )
    const latestAssistantAfterRealUser = latestRealUser
      ? messages.findLast(
          (message): message is Message.FullMsg & { info: Message.AssistantInfo } =>
            message.info.role === "assistant" && latestRealUser.info.id < message.info.id,
        )
      : undefined
    // Deliver notifications only once the latest real user turn has settled (finished, or interrupted by ESC: abort
    // writes no finish but isTurnSettled recognizes it). Treating interrupted turns as settled lets workflow
    // termination notices through instead of being buried by repeated interrupts.
    if (latestRealUser && !isTurnSettled(latestAssistantAfterRealUser?.info)) return messages

    const latestNotificationUser = messages.findLast(
      (message): message is Message.FullMsg & { info: Message.UserInfo } =>
        message.info.role === "user" && isNotificationUser(message),
    )
    if (latestNotificationUser) {
      const ids = notificationIDsFromMessage(latestNotificationUser)
      const current = notifications.some((item) => ids.includes(item.id))
      const assistant = messages.findLast(
        (message): message is Message.FullMsg & { info: Message.AssistantInfo } =>
          message.info.role === "assistant" && latestNotificationUser.info.id < message.info.id,
      )
      if (current && !assistant) return messages
      if (current && assistant && !isTurnSettled(assistant.info)) return messages
      if (current && assistant && !assistant.info.error) return messages
    }

    const latestUser = messages.findLast(
      (message): message is Message.FullMsg & { info: Message.UserInfo } => message.info.role === "user",
    )
    const latestNotification = notifications[notifications.length - 1]
    const model = latestNotification.model ?? latestUser?.info.model
    const agent = latestNotification.agent ?? latestUser?.info.agent
    if (!model || !agent) return messages

    const info: Message.UserInfo = {
      id: Identifier.ascending("message"),
      role: "user",
      sessionID: input.sessionID,
      time: {
        created: Date.now(),
      },
      agent,
      model,
      variant: latestUser?.info.variant,
      // Inherit the latest real user message's permission mode; otherwise the client falls back to "ask" for the
      // notification turn and shows an auto session as ask. Use latestRealUser, not latestUser, which may be an earlier
      // synthetic notification message without a permissionLevel.
      permissionLevel: latestRealUser?.info.permissionLevel,
    }
    const notificationIDs = notifications.map((item) => item.id)
    await Session.updateInfo(info)
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: info.id,
      sessionID: input.sessionID,
      type: "text",
      text: SessionNotification.promptText(notifications),
      synthetic: true,
      metadata: {
        source: "session.notification",
        notificationIDs,
        taskOriginMessageIDs: notifications.flatMap((item) =>
          typeof item.metadata?.taskOriginMessageID === "string" ? [item.metadata.taskOriginMessageID] : [],
        ),
        planExecutionIDs: notifications.flatMap((item) =>
          typeof item.metadata?.planExecutionID === "string" ? [item.metadata.planExecutionID] : [],
        ),
      },
    } satisfies Message.TextPart)
    await SessionNotification.markDelivered(input.sessionID, notificationIDs, info.id)
    await Session.touch(input.sessionID)
    return Message.filterCompacted(Message.stream(input.sessionID))
  }

  function notificationIDsFromMessage(message: Message.FullMsg) {
    return [
      ...new Set(
        message.parts.flatMap((part) => {
          if (part.type !== "text") return []
          if (part.metadata?.source !== "session.notification") return []
          const ids = part.metadata.notificationIDs
          if (!Array.isArray(ids)) return []
          return ids.filter((id): id is string => typeof id === "string")
        }),
      ),
    ]
  }

  function isNotificationUser(message: Message.FullMsg) {
    if (message.info.role !== "user") return false
    return notificationIDsFromMessage(message).length > 0
  }

  function isFinishedAssistant(assistant: Message.AssistantInfo | undefined) {
    if (!assistant?.finish) return false
    return !["tool-calls", "unknown"].includes(assistant.finish)
  }

  /**
   * Whether an assistant turn has settled and will produce nothing more.
   *
   * Unlike isFinishedAssistant: on a user interrupt (ESC) the processor writes only error (MessageAbortedError), not
   * finish, so isFinishedAssistant reports it as unfinished and the delivery guard would swallow workflow termination
   * notices. Here AbortedError also counts as settled, so notifications can be delivered after an interrupt.
   *
   * Only for the delivery/redelivery guard. Acking successful turns still uses isFinishedAssistant (aborted is not a
   * success; shouldAckDeliveredTurn handles that ack).
   */
  function isTurnSettled(assistant: Message.AssistantInfo | undefined): boolean {
    if (!assistant) return false
    if (assistant.error && Message.AbortedError.isInstance(assistant.error)) return true
    return isFinishedAssistant(assistant)
  }

  /**
   * Whether a delivered notification turn should be acked.
   *
   * - No assistant reply: no ack (the turn has not ended; check again next loop).
   * - Success (no error): ack.
   * - User interrupt (MessageAbortedError): ack. Otherwise, after cancel() sets idle, SessionNotificationDelivery
   *   redelivers the same notification with {delay: 0}, looping interrupt, idle, redeliver, stream again, so ESC
   *   could never stop the stream.
   * - Real failure (any other error): no ack; the deliverer retries with exponential backoff.
   */
  function shouldAckDeliveredTurn(assistant: Message.AssistantInfo | undefined): boolean {
    if (!assistant) return false
    if (!assistant.error) return true
    return Message.AbortedError.isInstance(assistant.error)
  }

  /**
   * Whether the agent loop should exit at the top without calling the LLM again.
   *
   * - No assistant reply yet: continue (first step or resume).
   * - The latest assistant's parentID is not the latest user message (the user sent a new one): continue so the new
   *   turn takes over. Compare by parent rather than id order: the 48-bit timestamp in message ids wraps about every
   *   795 days, after which a new user id sorts below an old assistant id and would be mistaken for no new message.
   * - The latest assistant was interrupted by the user (MessageAbortedError): exit. Abort writes only error, not
   *   finish, so without this a new loop would treat the turn as unfinished and keep driving the LLM after ESC.
   * - The latest assistant finished normally (finish is not tool-calls/unknown): exit.
   * - finish is tool-calls/unknown (including in-progress tool use): continue the loop.
   */
  function shouldExitLoop(lastAssistant: Message.AssistantInfo | undefined, lastUserID: string | undefined): boolean {
    if (!lastAssistant) return false
    if (lastUserID !== undefined && lastAssistant.parentID !== lastUserID) return false
    if (lastAssistant.error && Message.AbortedError.isInstance(lastAssistant.error)) return true
    if (lastAssistant.finish && !["tool-calls", "unknown"].includes(lastAssistant.finish)) return true
    return false
  }

  async function ackSuccessfulNotificationTurn(input: {
    sessionID: string
    user: Message.FullMsg | undefined
    assistant: Message.AssistantInfo
  }) {
    if (!input.user) return
    if (!isNotificationUser(input.user)) return
    if (!isFinishedAssistant(input.assistant)) return
    if (input.assistant.error) return
    const ids = notificationIDsFromMessage(input.user)
    if (ids.length === 0) return
    await SessionNotification.ack(input.sessionID, ids)
  }

  async function ackDeliveredSessionNotifications(input: { sessionID: string; messages: Message.FullMsg[] }) {
    const notifications = await SessionNotification.list(input.sessionID)
    if (notifications.length === 0) return input.messages
    const pending = new Set(notifications.map((item) => item.id))
    let acked = false
    for (const message of input.messages) {
      if (!isNotificationUser(message)) continue
      const ids = notificationIDsFromMessage(message).filter((id) => pending.has(id))
      if (ids.length === 0) continue
      const assistant = input.messages.findLast(
        (item): item is Message.FullMsg & { info: Message.AssistantInfo } =>
          !Message.isExternal(item.info) &&
          item.info.role === "assistant" &&
          message.info.id < item.info.id &&
          isTurnSettled(item.info),
      )
      // An interrupted turn (AbortedError) is acked so it is not redelivered in a loop; see shouldAckDeliveredTurn.
      if (!shouldAckDeliveredTurn(assistant?.info)) continue
      await SessionNotification.ack(input.sessionID, ids)
      ids.forEach((id) => pending.delete(id))
      acked = true
    }
    if (!acked) return input.messages
    return Message.filterCompacted(Message.stream(input.sessionID))
  }

  /**
   * A session is a child when:
   * - session.parentID is set (any resumed child session or internal branch), or
   * - child=true is passed explicitly (SubAgentTool / slash subtask).
   *
   * The nested subagent ban depends only on parentID / child, not on the permission mode.
   */
  /** Child sessions use the root session's session grants (the root's own are already in session.permission). */
  export async function grantsOf(session: Session.Info): Promise<PermissionNext.Ruleset> {
    if (!session.parentID) return []
    return PermissionNext.grants(await Session.rootID(session.id))
  }

  /**
   * The session's permission mode. Child sessions (subagents, workflows) always follow the root session, so they never
   * exceed its permissions and a live mode switch applies to the whole tree at once. fallback (the mode sent with this
   * turn's message) is used when the root session has not recorded a mode yet.
   */
  export const modeOf = permissionLevelOf

  /**
   * Rule chain rebuilt before each tool execute (evaluate picks the last matching rule):
   *   permission mode defaults, then user config (agent.permission) and session rules, then read-only mode denials
   *   (all three from PermissionPolicy.ruleset), then agent hard limits (restrictedRules), then the nested subagent ban
   *   for child sessions.
   * Session grants live on the root session: the root's own are in session.permission; for child sessions the caller
   * passes the root's grants.
   */
  export const buildToolExecutionRuleset = PermissionPolicy.execution

  /** @internal Exported for testing */
  export async function resolveTools(input: {
    agent: Agent.Info
    model: Provider.Model
    session: Session.Info
    tools?: Record<string, boolean>
    processor: SessionProcessor.Info
    bypassAgentCheck: boolean
    messages: Message.FullMsg[]
    permissionLevel?: PermissionLevel.Value
    child?: boolean
    /**
     * Step number in the current turn. Only used to run tool discovery once, on step 1: the query does not change
     * within a turn and step 1's result is already persisted as a marker part, while CJK n-gram scoring with a long
     * query and many MCP candidates can take hundreds of milliseconds per run. Defaults to 1 for tests.
     */
    prepared?: Awaited<ReturnType<typeof prepareTools>>
    planExecution?: boolean
    step?: number
  }) {
    using _ = log.time("resolveTools")
    const tools: Record<string, AITool> = {}

    const effectivePermissionLevel = input.permissionLevel ?? PermissionLevel.DEFAULT

    const planSnapshot = !input.session.parentID ? await SessionPlan.get(input.session.id) : undefined

    /**
     * Reads the latest Agent/Session before every actual tool call.
     * The ruleset and ctx.permissionLevel / ctx.kind must share one source: after a live mode switch, commands, paths
     * outside the workspace and plan switches must be judged by the new mode, not the one captured by resolveTools.
     */
    async function liveExecution() {
      const [agentNext, sessionNext] = await Promise.all([Agent.get(input.agent.id), Session.get(input.session.id)])
      const agent = agentNext ?? input.agent
      const session = sessionNext ?? input.session
      const permissionLevel = await modeOf(session, effectivePermissionLevel)
      return {
        permissionLevel,
        ruleset: buildToolExecutionRuleset({
          agent,
          session,
          permissionLevel,
          child: input.child,
          grants: await grantsOf(session),
        }),
      }
    }

    /** Child session approvals are shown in the root session, with the root id and source (agent, subtask title). */
    const origin = lazy(async () => {
      if (!input.session.parentID) return {}
      return {
        root: await Session.rootID(input.session.id),
        source: { sessionID: input.session.id, agent: input.agent.id, title: input.session.title },
      }
    })

    /**
     * Registers a per-call AbortController and returns a dispose handle.
     * The tool wrapper calls dispose() in finally to clean up toolAborts and avoid leaks in long sessions.
     * dispose() is idempotent and safe to call after an abort.
     */
    async function registerToolAbort(
      callID: string | undefined,
      toolID: string,
    ): Promise<{ signal: AbortSignal | undefined; dispose: () => void }> {
      const activePlan = await SessionPlan.get(input.session.id)
      const sessionState = state()[input.session.id]
      if (!callID) return { signal: undefined, dispose: () => {} }
      const childAbort = new AbortController()
      sessionState?.toolAborts.set(callID, childAbort)
      const finish = ModeOperations.register(
        input.session.id,
        callID,
        toolID,
        childAbort,
        async () => (await liveExecution()).ruleset,
        input.planExecution && activePlan.status === "executing" ? activePlan.execution?.id : undefined,
      )
      const cascadeAbort = () => childAbort.abort()
      sessionState?.abort.signal.addEventListener("abort", cascadeAbort, { once: true })
      const dispose = () => {
        sessionState?.abort.signal.removeEventListener("abort", cascadeAbort)
        sessionState?.toolAborts.delete(callID)
        finish()
      }
      return { signal: childAbort.signal, dispose }
    }

    const context = (
      args: any,
      options: ToolExecutionOptions<unknown>,
      ruleset: PermissionNext.Ruleset,
      abortSignal?: AbortSignal,
      permissionLevel: PermissionLevel.Value = effectivePermissionLevel,
    ): Tool.Context => {
      const ctx: Tool.Context = {
        sessionID: input.session.id,
        abort: abortSignal ?? options.abortSignal!,
        messageID: input.processor.message.id,
        callID: options.toolCallId,
        planExecution: input.planExecution,
        extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, planRevision: planSnapshot?.revision },
        agent: input.agent.id,
        get permissionLevel() {
          return permissionLevelNow(input.session.id, permissionLevel)
        },
        get kind() {
          return permissionLevelNow(input.session.id, permissionLevel)
        },
        messages: input.messages,
        ruleset,
        metadata: async (val: { title?: string; metadata?: any }) => {
          const match = input.processor.partFromToolCall(options.toolCallId)
          if (match && match.state.status === "running") {
            const updated = await Session.updatePart({
              ...match,
              state: {
                title: val.title,
                metadata: val.metadata,
                status: "running",
                input: args,
                time: match.state.time,
              },
            })
            Object.assign(match, updated)
            return
          }
          if (match && match.state.status === "completed") {
            const updated = await Session.updatePart({
              ...match,
              state: {
                ...match.state,
                title: val.title ?? match.state.title,
                metadata: val.metadata ?? match.state.metadata,
              },
            })
            Object.assign(match, updated)
            return
          }
          await input.processor.updateToolCallMetadata(options.toolCallId, val)
        },
        async ask(req) {
          abortSignal?.throwIfAborted()
          ModeOperations.record(
            input.session.id,
            options.toolCallId,
            req.checks ?? (req.patterns ?? []).map((pattern) => ({ permission: req.permission, pattern, grants: [] })),
          )
          const admission = await PermissionNext.askCurrent(
            {
              ...req,
              sessionID: input.session.id,
              ...(await origin()),
              tool: { messageID: input.processor.message.id, callID: options.toolCallId },
            },
            async () => (await liveExecution()).ruleset,
            abortSignal,
          )
          abortSignal?.throwIfAborted()
          ModeOperations.authorize(input.session.id, options.toolCallId, admission)
          return admission
        },
      }
      return ctx
    }

    const prepared = input.prepared ?? (await prepareTools(input))
    const { standardTools, mcpTools, mcpServerNames, mcpIds, dynamic, deferred, autoActivated } = prepared
    for (const item of standardTools) {
      if (deferred.isPending(item.id)) continue
      if (item.id === "delegate" && input.session.metadata?.group !== true) continue
      const schema = ProviderTransform.schema(input.model, z.toJSONSchema(item.parameters))
      tools[item.id] = tool({
        id: item.id as any,
        description: item.description,
        inputSchema: jsonSchema(schema as any),
        async execute(args, options) {
          const live = await liveExecution()
          if (!PermissionLevel.allowsTool(permissionLevelNow(input.session.id, live.permissionLevel), item.id))
            throw new PermissionNext.DeniedError([{ permission: item.id, pattern: "*", action: "deny" }])
          const abort = await registerToolAbort(options.toolCallId, item.id)
          const signal =
            abort.signal && options.abortSignal
              ? AbortSignal.any([abort.signal, options.abortSignal])
              : (abort.signal ?? options.abortSignal)
          const ctx = context(args, options, live.ruleset, signal, live.permissionLevel)
          try {
            await Plugin.trigger(
              "tool.execute.before",
              {
                tool: item.id,
                sessionID: ctx.sessionID,
                callID: ctx.callID,
              },
              {
                args,
              },
            )
            ctx.abort.throwIfAborted()
            const result = await item.execute(args, ctx)
            await Plugin.trigger(
              "tool.execute.after",
              {
                tool: item.id,
                sessionID: ctx.sessionID,
                callID: ctx.callID,
                args,
              },
              result,
            )
            return result
          } finally {
            abort.dispose()
          }
        },
      })
    }

    for (const [key, item] of Object.entries(mcpTools)) {
      const execute = item.execute
      if (!execute) continue

      // Only MCP tools explicitly marked deferred:true are left out until activated (see buildDeferredPlan).
      if (deferred.isPending(key)) continue

      const transformed = ProviderTransform.schema(input.model, await asSchema(item.inputSchema).jsonSchema)
      item.inputSchema = jsonSchema(transformed)
      // Wrap execute to add plugin hooks and format output
      item.execute = async (args, opts) => {
        const live = await liveExecution()
        if (!PermissionLevel.allowsTool(permissionLevelNow(input.session.id, live.permissionLevel), key))
          throw new PermissionNext.DeniedError([{ permission: key, pattern: "*", action: "deny" }])
        const abort = await registerToolAbort(opts.toolCallId, key)
        const signal =
          abort.signal && opts.abortSignal
            ? AbortSignal.any([abort.signal, opts.abortSignal])
            : (abort.signal ?? opts.abortSignal)
        const ctx = context(args, opts, live.ruleset, signal, live.permissionLevel)
        let result: Awaited<ReturnType<typeof execute>>
        try {
          await Plugin.trigger(
            "tool.execute.before",
            {
              tool: key,
              sessionID: ctx.sessionID,
              callID: opts.toolCallId,
            },
            {
              args,
            },
          )

          // Ask before the first call of an MCP tool (not in auto mode); the user can choose to always allow it.
          const server = mcpServerNames.find((name) => key.startsWith(name.replace(/[^a-zA-Z0-9_-]/g, "_") + "_"))
          const check = PermissionPolicy.mcp(server ?? key, server ? key.slice(server.length + 1) : "*")
          await ctx.ask({ permission: "mcp", checks: [check], metadata: { toolName: key, server } })

          signal?.throwIfAborted()
          result = await execute(args, { ...opts, abortSignal: signal })

          await Plugin.trigger(
            "tool.execute.after",
            {
              tool: key,
              sessionID: ctx.sessionID,
              callID: opts.toolCallId,
              args,
            },
            result,
          )
        } finally {
          abort.dispose()
        }

        const textParts: string[] = []
        const attachments: Message.FilePart[] = []

        for (const contentItem of result.content) {
          if (contentItem.type === "text") {
            textParts.push(contentItem.text)
          } else if (contentItem.type === "image") {
            attachments.push({
              id: Identifier.ascending("part"),
              sessionID: input.session.id,
              messageID: input.processor.message.id,
              type: "file",
              mime: contentItem.mimeType,
              url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
            })
          } else if (contentItem.type === "resource") {
            const { resource } = contentItem
            if (resource.text) {
              textParts.push(resource.text)
            }
            if (resource.blob) {
              attachments.push({
                id: Identifier.ascending("part"),
                sessionID: input.session.id,
                messageID: input.processor.message.id,
                type: "file",
                mime: resource.mimeType ?? "application/octet-stream",
                url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                filename: resource.uri,
              })
            }
          }
        }

        const truncated = await Truncate.output(textParts.join("\n\n"), {}, input.agent)
        const metadata = {
          ...(result.metadata ?? {}),
          mcpIsError: result.isError === true,
          truncated: truncated.truncated,
          ...(truncated.truncated && { outputPath: truncated.outputPath }),
        }

        return {
          title: "",
          metadata,
          output: truncated.content,
          attachments,
          content: result.content, // directly return content to preserve ordering when outputting to model
        }
      }
      tools[key] = item
    }

    for (const id of Object.keys(tools)) {
      if (id !== "StructuredOutput" && !prepared.visible(id)) delete tools[id]
    }
    const search = prepared.search(new Set(Object.keys(tools)))
    if (search) tools.tool_search = search
    // mcpIds and dynamicToolIds are passed on to LLM.stream so llm.ts does not call MCP.tools() or
    // ToolRegistry.dynamicIds() again. autoActivated lists tools activated by Stage A/B this turn; the caller must
    // write a marker part for them, or scanActivatedTools will not see them next turn and they revert to deferred.
    return { tools, mcpIds, dynamicToolIds: dynamic, autoActivated, prepared }
  }

  /** @internal Exported for testing */
  export function createStructuredOutputTool(input: {
    schema: Record<string, any>
    onSuccess: (output: unknown) => void
  }): AITool {
    // Remove $schema property if present (not needed for tool input)
    const { $schema, ...toolSchema } = input.schema

    return tool({
      description: STRUCTURED_OUTPUT_DESCRIPTION,
      inputSchema: jsonSchema(toolSchema as any),
      async execute(args) {
        // AI SDK validates args against inputSchema before calling execute()
        input.onSuccess(args)
        return {
          output: "Structured output captured successfully.",
          title: "Structured Output",
          metadata: { valid: true },
        }
      },
      toModelOutput({ output }) {
        return {
          type: "text",
          value: output.output,
        }
      },
    })
  }

  /** Other files next to SKILL.md, so the model can open tests.md and the like. Built-in skills have no disk directory. */
  async function skillMentionText(skill: Skill.Info) {
    const lines = [`<skill_content name="${skill.name}">`, skill.content.trim()]
    if (!skill.location.startsWith("<builtin>/")) {
      const dir = path.dirname(skill.location)
      const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])
      const files = entries
        .filter((entry) => entry.isFile() && entry.name !== "SKILL.md")
        .slice(0, 10)
        .map((entry) => path.join(entry.parentPath, entry.name).replaceAll("\\", "/"))
      lines.push("", `Base directory for this skill: ${pathToFileURL(dir).href}`)
      lines.push("<skill_files>", ...files.map((file) => `<file>${file}</file>`), "</skill_files>")
    }
    lines.push("</skill_content>")
    return lines.join("\n")
  }

  /** Loads each /name in the user's own text. The skill body stays on the message so later turns still see it. */
  async function loadMentionedSkills(sessionID: string, messageID: string, parts: Message.Part[], agent: Agent.Info) {
    const skills = await LoopExecution.wait(async () => SkillSearch.accessible({ skills: await Skill.all(), agent }))
    const byName = new Map<string, Skill.Info>()
    for (const skill of skills) if (!byName.has(skill.name)) byName.set(skill.name, skill)
    const names = new Set(byName.keys())
    const seen = new Set<string>()
    const extra: Message.Part[] = []
    for (const part of parts) {
      if (part.type !== "text" || part.synthetic || part.ignored) continue
      for (const name of Skill.mentioned(part.text, names)) {
        if (seen.has(name)) continue
        seen.add(name)
        const skill = byName.get(name)
        if (!skill) continue
        extra.push({
          id: Identifier.ascending("part"),
          messageID,
          sessionID,
          type: "text",
          synthetic: true,
          text: await skillMentionText(skill),
        })
      }
    }
    return extra
  }

  async function createUserMessage(input: PromptInput, commandSource?: Message.UserInfo["commandSource"]) {
    LoopExecution.check(input.sessionID)
    const selection = await LoopExecution.wait(async () => PromptMode.resolve(input))
    const agent = await LoopExecution.wait(async () => Agent.get(selection.agentID))
    if (!agent) throw new Error(`Agent not found: ${selection.agentID}`)

    const model = input.model ?? agent.model ?? (await LoopExecution.wait(async () => lastModel(input.sessionID)))
    if (input.model) await Provider.remember(input.model)
    const full = await LoopExecution.wait(async () =>
      Provider.getModel(model.providerID, model.modelID).catch(() => undefined),
    )
    const history = await LoopExecution.wait(async () => Session.messages({ sessionID: input.sessionID }))
    const picked = history.some(
      (message) =>
        message.info.role === "user" &&
        !Message.isExternal(message.info) &&
        message.info.model.providerID === model.providerID &&
        message.info.model.modelID === model.modelID &&
        !!message.info.variant,
    )
    const configured = agent.model
    const owns =
      !!configured && configured.providerID === model.providerID && configured.modelID === model.modelID && !picked
    const requested = input.variant && full?.variants?.[input.variant] ? input.variant : undefined
    const fromAgent = owns && agent.variant && full?.variants?.[agent.variant] ? agent.variant : undefined
    const variant = requested ?? fromAgent ?? full?.defaultVariant

    const info: Message.Info = {
      id: input.messageID ?? Identifier.ascending("message"),
      role: "user",
      sessionID: input.sessionID,
      time: {
        created: Date.now(),
      },
      tools: input.tools,
      agent: agent.id,
      permissionLevel: selection.permissionLevel,
      metadata: input.metadata,
      model,
      system: input.system,
      commandSource,
      format: input.format,
      variant,
    }
    using _ = defer(() => ContextAttach.clear(info.id))
    await LoopExecution.wait(async () => RuleSession.noteUserTurn(input.sessionID, info.id))

    const parts = await LoopExecution.wait(async () =>
      Promise.all(
        input.parts.map(async (part): Promise<Message.Part[]> => {
          if (part.type === "file") {
            // before checking the protocol we check if this is an mcp resource because it needs special handling
            if (part.source?.type === "resource") {
              const { clientName, uri } = part.source
              log.info("mcp resource", { clientName, uri, mime: part.mime })

              const pieces: Message.Part[] = [
                {
                  id: Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Reading MCP resource: ${part.filename} (${uri})`,
                },
              ]

              try {
                const resourceContent = await LoopExecution.wait(async () => MCP.readResource(clientName, uri))
                if (!resourceContent) {
                  throw new Error(`Resource not found: ${clientName}/${uri}`)
                }

                // Handle different content types
                const contents = Array.isArray(resourceContent.contents)
                  ? resourceContent.contents
                  : [resourceContent.contents]

                for (const content of contents) {
                  if ("text" in content && content.text) {
                    pieces.push({
                      id: Identifier.ascending("part"),
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: content.text as string,
                    })
                  } else if ("blob" in content && content.blob) {
                    // Handle binary content if needed
                    const mimeType = "mimeType" in content ? content.mimeType : part.mime
                    pieces.push({
                      id: Identifier.ascending("part"),
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `[Binary content: ${mimeType}]`,
                    })
                  }
                }

                pieces.push({
                  ...part,
                  id: part.id ?? Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                })
              } catch (error: unknown) {
                log.error("failed to read MCP resource", { error, clientName, uri })
                const message = error instanceof Error ? error.message : String(error)
                pieces.push({
                  id: Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Failed to read MCP resource ${part.filename}: ${message}`,
                })
              }

              return pieces
            }
            const url = new URL(part.url)
            switch (url.protocol) {
              // Reference to a past conversation: the client only sends a pointer (session://<sessionID>), expanded
              // here into a transcript. Same three parts as file: below (what was done, the content, the original
              // part); keeping the original part lets the client restore the reference chip from history.
              case "session:": {
                const target = SessionReference.parse(part.url)
                const rendered = target
                  ? await LoopExecution.wait(async () =>
                      SessionReference.render(target, { user: info as Message.UserInfo }),
                    )
                  : undefined
                const text = rendered?.ok
                  ? rendered.text
                  : `Could not cite the past conversation: ${rendered && !rendered.ok ? rendered.error : part.url}`
                return [
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Referenced an earlier conversation: ${JSON.stringify({ sessionID: target ?? part.url })}`,
                  },
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text,
                  },
                  {
                    ...part,
                    id: part.id ?? Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                  },
                ]
              }
              case "data:":
                if (part.mime === "text/plain") {
                  return [
                    {
                      id: Identifier.ascending("part"),
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                    },
                    {
                      id: Identifier.ascending("part"),
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: Buffer.from(part.url, "base64url").toString(),
                    },
                    {
                      ...part,
                      id: part.id ?? Identifier.ascending("part"),
                      messageID: info.id,
                      sessionID: input.sessionID,
                    },
                  ]
                }
                break
              case "file:":
                log.info("file", { mime: part.mime })
                // have to normalize, symbol search returns absolute paths
                // Decode the pathname since URL constructor doesn't automatically decode it
                const filepath = fileURLToPath(part.url)
                const stat = await LoopExecution.wait(async () => fs.stat(filepath).catch(() => undefined))

                if (stat?.isDirectory()) {
                  part.mime = "application/x-directory"
                }

                // @-mentioned rule files: manual / agent-requested rules are pinned to the session; always / auto
                // skip the YAML dump. RulesPrompt.active puts the body into user-context, not the user message.
                if (part.mime === "text/plain") {
                  const action = await LoopExecution.wait(async () =>
                    RuleSession.handleMention({
                      sessionID: input.sessionID,
                      userMessageID: info.id,
                      filepath,
                    }),
                  )
                  if (action === "pin" || action === "skip") {
                    return [
                      {
                        ...part,
                        id: part.id ?? Identifier.ascending("part"),
                        messageID: info.id,
                        sessionID: input.sessionID,
                      },
                    ]
                  }
                }

                if (part.mime === "text/plain") {
                  await LoopExecution.wait(async () => RuleSession.recordFile(input.sessionID, filepath, info.id))
                  let offset: number | undefined = undefined
                  let limit: number | undefined = undefined
                  const range = {
                    start: url.searchParams.get("start"),
                    end: url.searchParams.get("end"),
                  }
                  if (range.start != null) {
                    const filePathURI = part.url.split("?")[0]
                    let start = parseInt(range.start)
                    let end = range.end ? parseInt(range.end) : undefined
                    // some LSP servers (eg, gopls) don't give full range in
                    // workspace/symbol searches, so we'll try to find the
                    // symbol in the document to get the full range
                    if (start === end) {
                      const symbols = await LoopExecution.wait(async () =>
                        LSP.documentSymbol(filePathURI).catch(() => []),
                      )
                      for (const symbol of symbols) {
                        let range: LSP.Range | undefined
                        if ("range" in symbol) {
                          range = symbol.range
                        } else if ("location" in symbol) {
                          range = symbol.location.range
                        }
                        if (range?.start?.line && range?.start?.line === start) {
                          start = range.start.line
                          end = range?.end?.line ?? start
                          break
                        }
                      }
                    }
                    offset = Math.max(start, 1)
                    if (end) {
                      limit = end - (offset - 1)
                    }
                  }
                  const args = { filePath: filepath, offset, limit }

                  const pieces: Message.Part[] = [
                    {
                      id: Identifier.ascending("part"),
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                    },
                  ]

                  await LoopExecution.wait(async () =>
                    ReadTool.init()
                      .then(async (t) => {
                        const model = await LoopExecution.wait(async () =>
                          Provider.getModel(info.model.providerID, info.model.modelID),
                        )
                        // Pre-read of a mentioned file: bypassCwdCheck skips directory and permission checks; no
                        // ruleset.
                        const readCtx: Tool.Context = {
                          sessionID: input.sessionID,
                          abort: new AbortController().signal,
                          agent: agent.id,
                          permissionLevel: PermissionLevel.DEFAULT,
                          kind: PermissionLevel.DEFAULT,
                          messageID: info.id,
                          extra: { bypassCwdCheck: true, model },
                          messages: input.system
                            ? [
                                {
                                  info,
                                  parts: [],
                                },
                              ]
                            : [],
                          ruleset: [],
                          metadata: async () => {},
                          ask: async () => {},
                        }
                        const result = await LoopExecution.wait(async () => t.execute(args, readCtx))
                        pieces.push({
                          id: Identifier.ascending("part"),
                          messageID: info.id,
                          sessionID: input.sessionID,
                          type: "text",
                          synthetic: true,
                          text: result.output,
                        })
                        if (result.attachments?.length) {
                          pieces.push(
                            ...result.attachments.map((attachment) => ({
                              ...attachment,
                              synthetic: true,
                              filename: attachment.filename ?? part.filename,
                              messageID: info.id,
                              sessionID: input.sessionID,
                            })),
                          )
                        } else {
                          pieces.push({
                            ...part,
                            id: part.id ?? Identifier.ascending("part"),
                            messageID: info.id,
                            sessionID: input.sessionID,
                          })
                        }
                      })
                      .catch((error) => {
                        log.error("failed to read file", { error })
                        const message = error instanceof Error ? error.message : error.toString()
                        Bus.publish(Session.Event.Error, {
                          sessionID: input.sessionID,
                          error: new NamedError.Unknown({
                            message,
                          }).toObject(),
                        })
                        pieces.push({
                          id: Identifier.ascending("part"),
                          messageID: info.id,
                          sessionID: input.sessionID,
                          type: "text",
                          synthetic: true,
                          text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                        })
                      }),
                  )

                  return pieces
                }

                if (part.mime === "application/x-directory") {
                  const args = { filePath: filepath }
                  // Pre-read as above: empty ruleset, no-op ask.
                  const listCtx: Tool.Context = {
                    sessionID: input.sessionID,
                    abort: new AbortController().signal,
                    agent: agent.id,
                    permissionLevel: PermissionLevel.DEFAULT,
                    kind: PermissionLevel.DEFAULT,
                    messageID: info.id,
                    extra: { bypassCwdCheck: true },
                    messages: [],
                    ruleset: [],
                    metadata: async () => {},
                    ask: async () => {},
                  }
                  const result = await LoopExecution.wait(async () =>
                    ReadTool.init().then((t) => t.execute(args, listCtx)),
                  )
                  return [
                    {
                      id: Identifier.ascending("part"),
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                    },
                    {
                      id: Identifier.ascending("part"),
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: result.output,
                    },
                    {
                      ...part,
                      id: part.id ?? Identifier.ascending("part"),
                      messageID: info.id,
                      sessionID: input.sessionID,
                    },
                  ]
                }

                const file = filepath
                FileTime.read(input.sessionID, filepath)
                await LoopExecution.wait(async () => RuleSession.recordFile(input.sessionID, filepath, info.id))
                return [
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    text: `Called the Read tool with the following input: {\"filePath\":\"${filepath}\"}`,
                    synthetic: true,
                  },
                  {
                    id: part.id ?? Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "file",
                    url:
                      `data:${part.mime};base64,` +
                      Buffer.from(await LoopExecution.wait(async () => Filesystem.readBytes(file))).toString("base64"),
                    mime: part.mime,
                    filename: part.filename!,
                    source: part.source,
                  },
                ]
            }
          }

          if (part.type === "agent") {
            // Check if this agent would be denied by subagent permission
            const perm = PermissionNext.evaluate("subagent", part.name, agent.permission)
            const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
            return [
              {
                id: Identifier.ascending("part"),
                ...part,
                messageID: info.id,
                sessionID: input.sessionID,
              },
              {
                id: Identifier.ascending("part"),
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                // An extra space is added here. Otherwise the 'Use' gets appended
                // to user's last word; making a combined word
                text:
                  " Use the above message and context to generate a prompt and call the subagent tool with subagent_type: " +
                  part.name +
                  hint,
              },
            ]
          }

          return [
            {
              id: Identifier.ascending("part"),
              ...part,
              messageID: info.id,
              sessionID: input.sessionID,
            },
          ]
        }),
      ).then((x) => x.flat()),
    )

    parts.push(...(await loadMentionedSkills(input.sessionID, info.id, parts, agent)))

    await LoopExecution.wait(async () =>
      Plugin.trigger(
        "chat.message",
        {
          sessionID: input.sessionID,
          agent: agent.id,
          model: input.model,
          messageID: input.messageID,
          variant: input.variant,
        },
        {
          message: info,
          parts,
        },
      ),
    )

    await persistPreparedUser(info, parts)

    return {
      info,
      parts,
    }
  }

  async function persistPreparedUser(info: Message.UserInfo, parts: Message.Part[]) {
    const persisted = makeDone()
    LoopExecution.onCancel(LoopExecution.current(info.sessionID), async () => {
      await persisted.promise
      await settleCancelledPrompt({ info, parts })
    })
    try {
      LoopExecution.check(info.sessionID)
      // Finish each in-flight storage write before reconciling cancellation. The
      // outer preparation remains abortable, but its late write cannot resurrect
      // an unanswered user message after the cancellation ACK.
      await Session.updateInfo(info)
      LoopExecution.check(info.sessionID)
      for (const part of parts) {
        await Session.updatePart(part)
        LoopExecution.check(info.sessionID)
      }
    } finally {
      persisted.resolve()
    }
  }

  export const ShellInput = z.object({
    sessionID: Identifier.schema("session"),
    agent: z.string(),
    permissionLevel: PermissionLevel.Schema.optional(),
    permissionMode: z
      .enum(["readonly", "ask"])
      .optional()
      .describe("Deprecated mode input; legacy auto must be explicitly reauthorized through permissionLevel."),
    /** @deprecated Use permissionLevel. */
    kind: PermissionLevel.Schema.optional(),
    model: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
      })
      .optional(),
    command: z.string(),
  })
  export type ShellInput = z.infer<typeof ShellInput>
  async function assertNativeOperation(sessionID: string) {
    await SessionCrash.reconcile(sessionID, () => Boolean(resume(sessionID)))
    return SessionTarget.assertNativeOperation(sessionID)
  }

  export async function shell(input: ShellInput) {
    input.permissionLevel ??= input.permissionMode ? "ask" : undefined
    await assertNativeOperation(input.sessionID)
    const controller = start(input.sessionID)
    if (!controller) {
      throw new Session.BusyError(input.sessionID)
    }
    const abort = controller.signal
    // shell owns its entry too (it called start): capture it and resolve done when the command finishes; otherwise
    // cancelTree waits for a done that never resolves until it times out (undo during a shell waits the full 3s).
    const self = state()[input.sessionID]

    using _ = defer(() => {
      // Release loop-stopped waiters: the command body has finished (or settled after abort), so resolving is safe.
      self?.done.resolve()
      // If no queued callbacks, cancel (the default)
      const callbacks = state()[input.sessionID]?.callbacks ?? []
      if (callbacks.length === 0) {
        self?.releaseCheckout()
        cancel(input.sessionID)
      } else {
        // Otherwise, trigger the session loop to process queued items
        run({ sessionID: input.sessionID, resume_existing: true }).catch((error) => {
          log.error("session loop failed to resume after shell command", { sessionID: input.sessionID, error })
        })
      }
    })

    const session = await Session.get(input.sessionID)
    if (session.revert) {
      await SessionRevert.cleanup(session)
    }
    const agent = await Agent.get(input.agent)
    const model = input.model ?? agent.model ?? (await lastModel(input.sessionID))
    const userInfo: Message.UserInfo = {
      id: Identifier.ascending("message"),
      sessionID: input.sessionID,
      time: {
        created: Date.now(),
      },
      role: "user",
      agent: input.agent,
      permissionLevel: permissionLevelNow(input.sessionID),
      model: {
        providerID: model.providerID,
        modelID: model.modelID,
      },
    }
    await Session.updateInfo(userInfo)
    const userPart: Message.Part = {
      type: "text",
      id: Identifier.ascending("part"),
      messageID: userInfo.id,
      sessionID: input.sessionID,
      text: "The following tool was executed by the user",
      synthetic: true,
    }
    await Session.updatePart(userPart)

    const assistantInfo: Message.AssistantInfo = {
      id: Identifier.ascending("message"),
      sessionID: input.sessionID,
      parentID: userInfo.id,
      mode: input.agent,
      agent: input.agent,
      cost: 0,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      time: {
        created: Date.now(),
      },
      role: "assistant",
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: model.modelID,
      providerID: model.providerID,
    }
    await Session.updateInfo(assistantInfo)
    const part: Message.Part = {
      type: "tool",
      id: Identifier.ascending("part"),
      messageID: assistantInfo.id,
      sessionID: input.sessionID,
      tool: "bash",
      callID: ulid(),
      state: {
        status: "running",
        time: {
          start: Date.now(),
        },
        input: {
          command: input.command,
        },
      },
    }
    await Session.updatePart(part)
    const shell = Shell.preferred()
    const shellName = (
      process.platform === "win32" ? path.win32.basename(shell, ".exe") : path.basename(shell)
    ).toLowerCase()

    const invocations: Record<string, { args: string[] }> = {
      nu: {
        args: ["-c", input.command],
      },
      fish: {
        args: ["-c", input.command],
      },
      zsh: {
        args: [
          "-c",
          "-l",
          `
            [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
            [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
            eval ${JSON.stringify(input.command)}
          `,
        ],
      },
      bash: {
        args: [
          "-c",
          "-l",
          `
            shopt -s expand_aliases
            [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
            eval ${JSON.stringify(input.command)}
          `,
        ],
      },
      // Windows cmd
      cmd: {
        args: ["/c", input.command],
      },
      // Windows PowerShell
      powershell: {
        args: ["-NoProfile", "-Command", input.command],
      },
      pwsh: {
        args: ["-NoProfile", "-Command", input.command],
      },
      // Fallback: any shell that doesn't match those above
      //  - No -l, for max compatibility
      "": {
        args: ["-c", `${input.command}`],
      },
    }

    const matchingInvocation = invocations[shellName] ?? invocations[""]
    const args = matchingInvocation?.args

    const cwd = Instance.directory
    const shellEnv = await Plugin.trigger("shell.env", { cwd }, { env: {} })
    const proc = spawn(shell, args, {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...shellEnv.env,
        TERM: "dumb",
      },
    })

    let output = ""

    // Stream only the output tail while running: pushing the full accumulated output on every chunk makes event
    // payloads grow quadratically. The complete output is still written to the completed state at the end.
    const progress = (chunk: Buffer) => {
      output += chunk.toString()
      if (part.state.status !== "running") return
      part.state.metadata = {
        output: metadataTail(output, SHELL_METADATA_LENGTH),
        description: "",
      }
      Session.updatePart(part)
    }
    proc.stdout?.on("data", progress)
    proc.stderr?.on("data", progress)

    let aborted = false
    let exited = false

    const kill = () => Shell.killTree(proc, { exited: () => exited })

    if (abort.aborted) {
      aborted = true
      await kill()
    }

    const abortHandler = () => {
      aborted = true
      void kill()
    }

    abort.addEventListener("abort", abortHandler, { once: true })

    const exit = await new Promise<number | null>((resolve) => {
      proc.on("close", (code) => {
        exited = true
        abort.removeEventListener("abort", abortHandler)
        resolve(code)
      })
    })

    if (aborted) {
      output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
    }
    assistantInfo.time.completed = Date.now()
    await Session.updateInfo(assistantInfo)
    if (part.state.status === "running") {
      const time = {
        ...part.state.time,
        end: Date.now(),
      }
      const input = part.state.input
      if (aborted || exit !== 0) {
        part.state = {
          status: "error",
          time,
          input,
          error: aborted
            ? "User aborted the command"
            : exit === null
              ? "Command terminated by signal"
              : `Exit code: ${exit}`,
          metadata: {
            output,
            exit,
            description: "",
            errorKind: "execution",
          },
        }
        await Session.updatePart(part)
        if (aborted) log.info("shell cancelled", { sessionID: session.id, exit, duration: time.end - time.start })
        else log.warn("shell failed", { sessionID: session.id, exit, duration: time.end - time.start })
        return { info: assistantInfo, parts: [part] }
      }
      part.state = {
        status: "completed",
        time,
        input,
        title: "",
        metadata: {
          output,
          exit,
          description: "",
        },
        output,
      }
      await Session.updatePart(part)
      log.info("shell completed", { sessionID: session.id, exit, duration: time.end - time.start })
    }
    return { info: assistantInfo, parts: [part] }
  }

  export const CommandInput = z.object({
    messageID: Identifier.schema("message").optional(),
    sessionID: Identifier.schema("session"),
    agent: z.string().optional(),
    model: z.string().optional(),
    permissionLevel: PermissionLevel.Schema.optional(),
    permissionMode: z
      .enum(["readonly", "ask"])
      .optional()
      .describe("Deprecated mode input; legacy auto must be explicitly reauthorized through permissionLevel."),
    /** @deprecated Use permissionLevel. */
    kind: PermissionLevel.Schema.optional(),
    arguments: z.string(),
    command: z.string(),
    variant: z.string().optional(),
    /** Per-turn metadata, copied as is to `UserInfo.metadata`. */
    metadata: z.record(z.string(), z.unknown()).optional(),
    parts: z
      .array(
        z.discriminatedUnion("type", [
          Message.FilePart.omit({
            messageID: true,
            sessionID: true,
          }).partial({
            id: true,
          }),
        ]),
      )
      .optional(),
  })
  export type CommandInput = z.infer<typeof CommandInput>
  const bashRegex = /!`([^`]+)`/g
  // Match [Image N] as single token, quoted strings, or non-space sequences
  const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
  const placeholderRegex = /\$(\d+)/g
  const quoteTrimRegex = /^["']|["']$/g
  /**
   * Regular expression to match @ file references in text
   * Matches @ followed by file paths, excluding commas, periods at end of sentences, and backticks
   * Does not match when preceded by word characters or backticks (to avoid email addresses and quoted references)
   */

  async function resolveCommandModel(input: CommandInput, command: Command.Info) {
    if (command.model) {
      return Provider.parseModel(command.model)
    }
    if (command.agent) {
      const commandAgent = command.agent
      const cmdAgent = await LoopExecution.wait(async () => Agent.get(commandAgent))
      if (cmdAgent?.model) {
        return cmdAgent.model
      }
    }
    if (input.model) return Provider.parseModel(input.model)
    return await LoopExecution.wait(async () => lastModel(input.sessionID))
  }

  async function getCommandModel(input: CommandInput, command: Command.Info) {
    const model = await LoopExecution.wait(async () => resolveCommandModel(input, command))
    try {
      return {
        ref: model,
        full: await LoopExecution.wait(async () => Provider.getModel(model.providerID, model.modelID)),
      }
    } catch (e) {
      LoopExecution.check(input.sessionID)
      publishProviderError(input.sessionID, e)
      throw e
    }
  }

  function publishProviderError(sessionID: string, e: unknown) {
    if (Provider.ModelNotFoundError.isInstance(e)) {
      const { providerID, modelID, suggestions } = e.data
      const suggestionsStr = suggestions?.join(", ") ?? ""
      const hint = suggestionsStr ? `, did you mean: ${suggestionsStr}?` : ""
      Bus.publish(Session.Event.Error, {
        sessionID,
        error: new Message.ModelNotFoundError({
          providerID,
          modelID,
          suggestions,
          messageKey: "error.modelNotFound",
          params: { provider: providerID, model: modelID, suggestions: suggestionsStr },
          message: `Model not found: ${providerID}/${modelID}${hint}`,
        }).toObject(),
      })
    }
  }

  async function getCommandAgent(input: CommandInput, agentID: string) {
    const agent = await LoopExecution.wait(async () => Agent.get(agentID))
    if (agent) return agent

    const available = await LoopExecution.wait(async () =>
      Agent.list().then((agents) => agents.filter((a) => !a.hidden).map((a) => a.id)),
    )
    const availableStr = available.join(", ")
    const hint = availableStr ? `, available agents: ${availableStr}` : ""
    const error = new Message.AgentNotFoundError({
      agent: agentID,
      available,
      messageKey: "error.agentNotFound2",
      params: { agent: agentID, available: availableStr },
      message: `Agent not found: "${agentID}"${hint}`,
    })
    Bus.publish(Session.Event.Error, {
      sessionID: input.sessionID,
      error: error.toObject(),
    })
    throw error
  }

  /**
   * Finishes a synchronous handler that did not go through loop().
   * A session that was never busy only gets session.status idle (to reset clients showing an optimistic busy state),
   * not session.idle, so the desktop does not show a "reply ready" notice.
   */
  function finishSyncCommand(sessionID: string) {
    LoopStatus.finishSync(sessionID)
  }

  /**
   * When a synchronous command has a follow-up task, injects the command output into the follow-up LLM system prompt
   * (the ignored report never reaches the context view).
   */
  function buildSyncFollowupSystem(commandName: string, output: string) {
    return `The user just ran the /${commandName} command. Its output is below; use it to answer the user's follow-up questions:\n\n${output}`
  }

  async function contextCommand(input: CommandInput, command: Command.Info, agentID: string) {
    LoopExecution.check(input.sessionID)
    assertNotBusy(input.sessionID)
    const [{ ref: commandModel, full: model }, agent, messages] = await LoopExecution.wait(async () =>
      Promise.all([
        getCommandModel(input, command),
        getCommandAgent(input, agentID),
        Message.filterCompacted(Message.stream(input.sessionID)),
      ]),
    )
    const created = Date.now()
    const userInfo: Message.UserInfo = {
      id: input.messageID ?? Identifier.ascending("message"),
      role: "user",
      sessionID: input.sessionID,
      time: {
        created,
      },
      agent: agent.id,
      model: commandModel,
      variant: input.variant,
    }
    await persistPreparedUser(userInfo, [
      {
        id: Identifier.ascending("part"),
        messageID: userInfo.id,
        sessionID: input.sessionID,
        type: "text",
        text: `/${input.command}${input.arguments.trim() ? ` ${input.arguments.trim()}` : ""}`,
        ignored: true,
        time: {
          start: created,
          end: created,
        },
      },
    ])
    await LoopExecution.wait(async () => Session.touch(input.sessionID))

    const view = await LoopExecution.wait(async () =>
      SessionContextView.build({
        messages,
        sessionID: input.sessionID,
        user: userInfo,
        agent,
        model,
        step: 1,
        includeToolStats: true,
      }),
    )
    const lang = await LoopExecution.wait(() => Text.lang())
    const report = SessionContextReport.format({ view, agent, model, lang })
    const completed = Date.now()
    const assistantInfo = (await LoopExecution.wait(async () =>
      Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "assistant",
        parentID: userInfo.id,
        sessionID: input.sessionID,
        mode: agent.id,
        agent: agent.id,
        variant: input.variant,
        path: {
          cwd: Instance.directory,
          root: Instance.worktree,
        },
        cost: 0,
        tokens: {
          total: 0,
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        finish: "stop",
        time: {
          created,
          completed,
        },
      }),
    )) as Message.AssistantInfo
    const part = await LoopExecution.wait(async () =>
      Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: assistantInfo.id,
        sessionID: input.sessionID,
        type: "text",
        text: report,
        ignored: true,
        time: {
          start: completed,
          end: completed,
        },
      }),
    )

    Bus.publish(Command.Event.Executed, {
      name: input.command,
      sessionID: input.sessionID,
      arguments: input.arguments,
      messageID: assistantInfo.id,
    })

    return {
      info: assistantInfo,
      parts: [part],
    }
  }

  /**
   * Builds a command's body and skill system text, without touching the model or the loop.
   * - Body: $1/$2/$ARGUMENTS in the template are replaced with the arguments; if the template uses none, the arguments
   *   are appended once at the end.
   * - System: skill commands load the full skill and tell the model to follow it for the user's request.
   */
  export async function resolveCommandInjection(input: {
    command: string
    arguments: string
  }): Promise<{ template: string; system: string | undefined }> {
    LoopExecution.check()
    const raw = input.arguments.match(argsRegex) ?? []
    const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))
    const command = await LoopExecution.wait(async () => Command.get(input.command))
    const templateCommand = command ? await LoopExecution.wait(async () => command.template) : ""

    // $1/$2 are positional and the last one takes the rest; $ARGUMENTS takes the whole string.
    const placeholders = templateCommand.match(placeholderRegex) ?? []
    let last = 0
    for (const item of placeholders) {
      const value = Number(item.slice(1))
      if (value > last) last = value
    }
    const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
      const position = Number(index)
      const argIndex = position - 1
      if (argIndex >= args.length) return ""
      if (position === last) return args.slice(argIndex).join(" ")
      return args[argIndex]
    })
    const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
    let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)
    if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
      template = template + "\n\n" + input.arguments
    }

    // Expand !`cmd` with the shell.
    const shell = ConfigMarkdown.shell(template)
    if (shell.length > 0) {
      const results = await LoopExecution.wait(async () =>
        Promise.all(
          shell.map(async ([, cmd]) => {
            try {
              return await LoopExecution.wait(async () => (await Shell.run(cmd)).text())
            } catch (error) {
              return `Error executing command: ${error instanceof Error ? error.message : String(error)}`
            }
          }),
        ),
      )
      let index = 0
      template = template.replace(bashRegex, () => results[index++])
    }
    template = template.trim()

    const skill =
      command?.source === "skill" ? await LoopExecution.wait(async () => Skill.get(command.name)) : undefined
    const system = skill
      ? `The user invoked the "${skill.name}" skill. Follow this skill for the user's request. Its full content follows:
${skill.content}`
      : undefined

    return { template, system }
  }

  export async function command(input: CommandInput): Promise<Message.NativeFullMsg> {
    input.permissionLevel ??= input.permissionMode ? "ask" : undefined
    const session = await assertNativeOperation(input.sessionID)
    await SessionTarget.assertNewMessage(session, input)
    if (LoopExecution.current() && !LoopExecution.current(input.sessionID)) {
      return LoopExecution.run(undefined, () => Loop.command(input))
    }
    LoopExecution.check(input.sessionID)
    log.info("command", { sessionID: input.sessionID, requestID: LoopExecution.current(input.sessionID)?.id })
    const requestedAgent = input.agent ?? (await LoopExecution.wait(async () => Agent.defaultAgent()))
    const command = await LoopExecution.wait(async () => Command.get(input.command))
    if (!command) {
      const error = new Message.CommandNotFoundError({
        command: input.command,
        messageKey: "error.commandNotFound",
        params: { command: input.command },
        message: `Command not found: "${input.command}"`,
      })
      Bus.publish(Session.Event.Error, {
        sessionID: input.sessionID,
        error: error.toObject(),
      })
      throw error
    }
    const agentID = command.agent ?? requestedAgent
    if (command.handler === "context") {
      const sync = await LoopExecution.wait(async () => contextCommand(input, command, agentID))
      const task = input.arguments.trim()
      if (!task) {
        finishSyncCommand(input.sessionID)
        return sync
      }

      // contextCommand already resolved the agent and model: reuse agentID and resolve the model ref the same way.
      const report = sync.parts.find((part) => part.type === "text") as Message.TextPart | undefined
      const { ref: commandModel } = await LoopExecution.wait(async () => getCommandModel(input, command))

      return prompt({
        sessionID: input.sessionID,
        model: commandModel,
        agent: agentID,
        permissionLevel: input.permissionLevel ?? input.kind,
        parts: [{ type: "text", text: task }],
        variant: input.variant,
        metadata: input.metadata,
        system: buildSyncFollowupSystem(input.command, report?.text ?? ""),
      })
    }

    const injection = await LoopExecution.wait(async () => resolveCommandInjection(input))
    const template = injection.template
    let system = injection.system

    const { ref: commandModel } = await LoopExecution.wait(async () => getCommandModel(input, command))

    // getCommandAgent already throws AgentNotFoundError listing the available agents.
    const agent = await LoopExecution.wait(async () => getCommandAgent(input, agentID))
    if (command.source === "skill" && system) {
      const allowed = await LoopExecution.wait(async () => SkillSearch.accessible({ agent }))
      if (!allowed.some((skill) => skill.name === command.name)) system = undefined
    }

    const expandedParts = await LoopExecution.wait(async () => resolvePromptParts(template))
    for (const part of expandedParts) part.id ??= Identifier.ascending("part")
    const isSubtask = (agent.mode === "subagent" && command.subtask !== false) || command.subtask === true
    const parts = isSubtask
      ? [
          {
            type: "subtask" as const,
            agent: agent.id,
            description: command.description ?? "",
            command: input.command,
            model: {
              providerID: commandModel.providerID,
              modelID: commandModel.modelID,
            },
            // TODO: how can we make subagent tool accept a more complex input?
            prompt: expandedParts.find((y) => y.type === "text")?.text ?? "",
          },
        ]
      : [...expandedParts, ...(input.parts ?? [])]
    for (const part of parts) part.id ??= Identifier.ascending("part")
    const commandSource = {
      templatePartIDs: isSubtask
        ? parts.filter((part) => part.type === "subtask").map((part) => part.id!)
        : expandedParts.filter((part) => part.type === "text").map((part) => part.id!),
    }

    const userAgent = isSubtask
      ? (input.agent ?? (await LoopExecution.wait(async () => Agent.defaultAgent())))
      : agentID
    const userModel = isSubtask
      ? input.model
        ? Provider.parseModel(input.model)
        : await LoopExecution.wait(async () => lastModel(input.sessionID))
      : commandModel

    await LoopExecution.wait(async () =>
      Plugin.trigger(
        "command.execute.before",
        {
          command: input.command,
          sessionID: input.sessionID,
          arguments: input.arguments,
        },
        { parts },
      ),
    )

    const result = (await LoopExecution.wait(async () =>
      promptInternal(
        {
          sessionID: input.sessionID,
          messageID: input.messageID,
          model: userModel,
          agent: userAgent,
          permissionLevel: input.permissionLevel ?? input.kind,
          parts,
          variant: input.variant,
          metadata: input.metadata,
          system,
        },
        { commandSource },
      ),
    )) as Message.FullMsg

    Bus.publish(Command.Event.Executed, {
      name: input.command,
      sessionID: input.sessionID,
      arguments: input.arguments,
      messageID: result.info.id,
    })

    return Message.native(result)
  }

  /**
   * Internal test entry point. Not public API; do not use from product code.
   */
  export const __test = {
    shouldAckDeliveredTurn,
    shouldExitLoop,
    isTurnSettled,
    buildSyncFollowupSystem,
  }
}
