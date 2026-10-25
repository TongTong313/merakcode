import path from "path"
import os from "os"
import fs from "fs/promises"
import z from "zod"
import { Identifier } from "@merakcode/util/id"
import { Message } from "./message"
import { Log } from "@merakcode/log/logger"
import { SessionRevert } from "./revert"
import { SessionReference } from "./reference"
import { SessionUndoRedo } from "./undo-redo"
import { cancelSessionTree, awaitLoopStopped } from "./cancel-tree"
import { Session } from "."
import { Storage } from "../storage/storage"
import { Agent, STANDARD_TOOL_POOL, computeDeferred } from "../agent/agent"
import { autoActivationMetadata, buildDeferredPlan, buildToolSearchTool } from "../tool/tool-search"
import { ToolDiscovery } from "../tool/tool-discovery"
import { ToolDiscoveryRerank } from "../tool/tool-discovery-rerank"
import { Provider } from "../provider/provider"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema, type ModelMessage } from "ai"
import { SessionCompaction } from "./compaction"
import { SessionContextView } from "./context-view"
import { SessionContextLayer } from "./context-layer"
import { Instance } from "../project/instance"
import { Bus } from "../bus"
import { ProviderTransform } from "../provider/transform"
import { ContextAttach } from "./context-attach"
import { Plugin } from "../plugin"
import BUILD_SWITCH from "../session/prompt/build-switch.txt"
import { planStayCallExitReminder, resolvePlanReminderKind } from "./plan-reminder"
import MAX_STEPS from "../session/prompt/max-steps.txt"
import { defer } from "@merakcode/util/defer"
import { ToolRegistry } from "../tool/registry"
import { PromptMode } from "./prompt-mode"
import { SessionExecution } from "./execution"
import { MCP } from "../mcp"
import { LSP } from "../lsp"
import { ReadTool } from "../tool/read"
import { FileTime } from "../file/time"
import { RuleSession } from "../rule/session-state"
import { Flag } from "../flag/flag"
import { ulid } from "ulid"
import { spawn } from "child_process"
import { Command } from "../command"
import { Skill } from "../skill"
import { fileURLToPath, pathToFileURL } from "url"
import { ConfigMarkdown } from "../config/markdown"
import { SessionSummary } from "./summary"
import { NamedError } from "@merakcode/util/error"
import { fn } from "../util/fn"
import { SessionProcessor } from "./processor"
import { SubAgentTool } from "../tool/subagent"
import { Tool } from "../tool/tool"
import { PermissionNext } from "../permission/next"
import { Question } from "../question/index"
import { PermissionMode } from "../permission/mode"
import { PermissionPolicy } from "../permission/policy"
import { SessionStatus } from "./status"
import { SessionNotification } from "./notification"
import { LLM } from "./llm"
import { iife } from "../util/iife"
import { lazy } from "../util/lazy"
import { Shell } from "../shell/shell"
import { Truncate } from "../tool/truncation"
import { metadataTail } from "../tool/output-sink"
import { Transcript } from "./transcript"
import { SessionContextReport } from "./context-report"
import { SkillSearch } from "../skill/search"
import { MemoryRecall } from "../memory/recall"
import { MemoryExtract } from "../memory/extract"
import { SessionMemory } from "../session-memory/session-memory"
import { AutoDream } from "../memory/dream/dream"
import { Filesystem } from "@merakcode/util/filesystem"
import { Text } from "../util/text"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

// Max output tail streamed while SessionRunner.shell runs; matches MAX_METADATA_LENGTH in the bash tool.
const SHELL_METADATA_LENGTH = 30_000

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

export namespace SessionRunner {
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
    scope?: SessionExecution.Scope
    options?: {
      requireIdle?: boolean
      commandSource?: Message.UserInfo["commandSource"]
    }
    message?: Message.FullMsg
    resolve(input: Message.FullMsg): void
    reject(reason?: any): void
  }

  type TurnCallback = {
    scope?: SessionExecution.Scope
    resolve(input: Message.FullMsg): void
    reject(reason?: any): void
  }

  type SessionState = {
    abort: AbortController
    toolAborts: Map<string, AbortController>
    running?: boolean
    callbacks: TurnCallback[]
    activeCallback?: TurnCallback
    queuedPrompts: QueuedPrompt[]
    /** Resolved when the owner loop body exits, after the processor has written any in-flight PatchPart. */
    done: { promise: Promise<void>; resolve: () => void }
  }

  // Runtime state is scoped per Instance.
  const state = Instance.state(
    () => {
      const data: Record<string, SessionState> = {}
      return data
    },
    async (current) => {
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
    const controller = new AbortController()
    const entries = admissions().get(sessionID) ?? new Set<AbortController>()
    entries.add(controller)
    admissions().set(sessionID, entries)
    return {
      signal: controller.signal,
      release() {
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
    permissionMode: PermissionMode.Schema.optional(),
    /** Per-turn metadata. The engine does not interpret it and copies it to `UserInfo.metadata`. */
    metadata: z.record(z.string(), z.unknown()).optional(),
    /** @deprecated Use permissionMode. Still parsed for older SubAgentTool / SDK callers. */
    kind: PermissionMode.Schema.optional(),
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

  async function persistSessionPermissionMode(session: Session.Info, mode: PermissionMode.Value | undefined) {
    if (!mode) return
    await Session.update(
      session.id,
      (draft) => {
        draft.permissionMode = mode
      },
      { touch: false },
    )
  }

  async function prepareAndCreatePromptMessage(
    input: PromptInput,
    options?: {
      commandSource?: Message.UserInfo["commandSource"]
    },
  ): Promise<Message.FullMsg> {
    SessionExecution.check(input.sessionID)
    const session = await SessionExecution.wait(async () => Session.get(input.sessionID))
    if (!session) throw new Storage.NotFoundError({ message: `Resource not found: session ${input.sessionID}` })

    // A new message discards the redo history.
    if (session.undoRedo?.stack?.length) {
      await SessionExecution.wait(async () => SessionUndoRedo.discard({ sessionID: session.id }))
    } else if (session.revert) {
      await SessionExecution.wait(async () => SessionRevert.cleanup(session))
    }

    const allMsgs = await SessionExecution.wait(async () => Message.filterCompacted(Message.stream(input.sessionID)))
    const lastID = allMsgs.at(-1)?.info.id
    const freshID = Identifier.ascending("message")
    const messageID = !input.messageID || (lastID && input.messageID <= lastID) ? freshID : input.messageID

    const message = await SessionExecution.wait(async () =>
      createUserMessage({ ...input, messageID }, options?.commandSource),
    )
    await SessionExecution.wait(async () => Session.touch(input.sessionID))

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
      await SessionExecution.wait(async () =>
        Session.update(session.id, (draft) => {
          draft.permission = PermissionNext.mergeUnique(draft.permission ?? [], permissions)
        }),
      )
    }

    // Write the message's permission mode back to the session, which is the source of truth. The mode sent with a
    // prompt and a live setPermissionMode change then share one field and cannot diverge (e.g. the client switches back
    // to ask while the session stays in auto). Child sessions persist it too (subagents pass "auto",
    // memory-extractor passes "ask"), so restoring after compaction or re-entry does not hit the `parentID ? "auto"`
    // fallback and flip the caller's choice.
    if (message.info.role === "user") {
      await SessionExecution.wait(async () => persistSessionPermissionMode(session, message.info.permissionMode))
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
        const guard = await SessionExecution.wait(async () =>
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
    if (SessionExecution.current() && !SessionExecution.current(input.sessionID)) {
      return SessionExecution.run(undefined, () => promptInternal(input, options))
    }
    SessionExecution.check(input.sessionID)
    if (options?.requireIdle === true) {
      assertNotBusy(input.sessionID)
    }

    const admission = admit(input.sessionID)
    try {
      const message = await prepareAndCreatePromptMessage(input, options)
      SessionExecution.check(input.sessionID)
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
            scope: SessionExecution.current(input.sessionID),
            options,
            message,
            resolve,
            reject,
          })
        })
      }

      return loop({
        sessionID: input.sessionID,
        permissionMode:
          message.info.role === "user" ? message.info.permissionMode : (input.permissionMode ?? input.kind),
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
  export const prompt = fn(PromptInput, (input) => promptInternal(publicPromptInput(input)))
  export const promptWhenIdle = fn(PromptInput, (input) =>
    promptInternal(publicPromptInput(input), { requireIdle: true }),
  )
  // Engine-generated memory/dream prompts keep synthetic; not exposed through HTTP or the SDK.
  export const promptGenerated = fn(PromptInput, promptInternal)
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
    SessionExecution.check(input.user.sessionID)
    const text = input.message ?? (await SessionExecution.wait(() => Text.pick(GENERIC_REFUSAL_MESSAGE)))
    const now = Date.now()
    const info = (await SessionExecution.wait(async () =>
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
    const part = await SessionExecution.wait(async () =>
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
    SessionExecution.check()
    const parts: PromptInput["parts"] = [
      {
        type: "text",
        text: template,
      },
    ]
    const files = ConfigMarkdown.files(template)
    const seen = new Set<string>()
    await SessionExecution.wait(async () =>
      Promise.all(
        files.map(async (match) => {
          const name = match[1]
          if (seen.has(name)) return
          seen.add(name)
          const filepath = name.startsWith("~/")
            ? path.join(os.homedir(), name.slice(2))
            : path.resolve(Instance.worktree, name)

          const stats = await SessionExecution.wait(async () => fs.stat(filepath).catch(() => undefined))
          if (!stats) {
            const agent = await SessionExecution.wait(async () => Agent.get(name))
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
    const controller = new AbortController()
    s[sessionID] = {
      abort: controller,
      toolAborts: new Map(),
      callbacks: [],
      queuedPrompts: [],
      done: makeDone(),
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
    SessionStatus.set(sessionID, { type: "idle" })
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
    SessionStatus.set(sessionID, { type: "idle" })
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
      const scope = SessionExecution.select(sessionID, requestIDs)
      if (scope) await SessionExecution.cancel(sessionID, [scope.id])
      return
    }

    const current = previous.activeCallback?.scope ?? previous.callbacks[0]?.scope
    const scope = current && SessionExecution.select(sessionID, requestIDs, current)
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
    const scoped = scope ? SessionExecution.cancel(sessionID, [scope.id]) : Promise.resolve()
    const reconciliation = reconciliations().get(sessionID)

    // Reserve the next owner before yielding. New input must join the same queue
    // while the aborted owner is still settling, rather than start another loop.
    const controller = start(sessionID)!
    const self = state()[sessionID]
    self.queuedPrompts = queued
    self.running = true
    SessionStatus.set(sessionID, { type: "busy" })
    log.info("prompt queue retained after interrupt", { sessionID, count: queued.length })

    void SessionExecution.run(undefined, async () => {
      // Cancellation ACK has a bounded wait; queue execution requires actual
      // settlement so an old tool or processor cannot overlap the next turn.
      await Promise.all([previous.done.promise, reconciliation])
      if (controller.signal.aborted || state()[sessionID] !== self) {
        self.done.resolve()
        return
      }
      if (!self.queuedPrompts.length) {
        self.done.resolve()
        releaseOwner(sessionID, controller)
        return
      }
      SessionStatus.set(sessionID, { type: "busy" })
      log.info("prompt queue resumed after interrupt", { sessionID, count: self.queuedPrompts.length })
      await processSessionTurns({ sessionID, controller, self })
    })

    await Promise.all([stopped, scoped])
  }

  export async function cancelTree(sessionID: string) {
    const { WorkflowState } = await import("../workflow/state")
    const { BashJobStore } = await import("../tool/bash-background")
    await cancelSessionTree(sessionID, {
      cancelSelf: async (id) => {
        state()[id]?.activeCallback?.reject(new Message.AbortedError({ message: "Operation aborted by user" }))
        const scoped = SessionExecution.cancel(id)
        await Promise.all([cancelAndSettle(id), scoped])
      },
      listWorkflowRuns: (id) => WorkflowState.listRuns(id),
      cancelWorkflowRun: (id, runId) => WorkflowState.cancelRun(id, runId),
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
    permissionMode: PermissionMode.Schema.optional(),
    /** @deprecated Use permissionMode. */
    kind: PermissionMode.Schema.optional(),
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
      if (m.info.role !== "assistant") continue
      const info = m.info as Message.AssistantInfo
      if (!info.parentID) continue
      if ((info.finish && !["tool-calls", "unknown"].includes(info.finish)) || Boolean(info.error)) {
        completedUserIDs.add(info.parentID)
      }
    }

    for (const m of messages) {
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
    loopPermissionMode?: PermissionMode.Value
    maxTurns?: number
  }

  async function runTurn(input: RunTurnInput): Promise<Message.FullMsg> {
    const { sessionID, targetUserID, abort, loopPermissionMode, maxTurns } = input
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
          .filter((msg) => msg.info.role === "assistant" && msg.info.summary === true && Boolean(msg.info.error))
          .map((msg) => (msg.info as Message.AssistantInfo).parentID),
      )
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]
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
      // The session permission mode is the source of truth and is re-read every turn, so a live setPermissionMode
      // updates the next turn's tool pool and rules. Within a turn, liveExecution re-reads the session before each
      // tool call, so the ruleset and ctx.permissionMode share one source.
      const effectivePermissionMode = await modeOf(
        (await Session.get(sessionID).catch(() => undefined)) ?? session,
        loopPermissionMode ?? lastUserInfo.permissionMode,
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
          MemoryExtract.schedule({
            session,
            assistant: lastAssistantInfo,
            model: lastUserInfo.model,
          })
          SessionMemory.schedule({
            session,
            assistant: lastAssistantInfo,
            model: lastUserInfo.model,
            tokens: tokensFromUsage(lastAssistantInfo.tokens),
          })
          AutoDream.schedule({
            session,
            assistant: lastAssistantInfo,
            model: lastUserInfo.model,
          })
        }
        break
      }

      // Set busy only after confirming this turn will not exit immediately. Otherwise, after an ESC-interrupted turn, a
      // loop started by the notification deliverer would emit a busy pulse and break at once, making the client's
      // thinking animation mount and unmount (flicker). The immediate-exit path only emits idle. See shouldExitLoop.
      SessionStatus.set(sessionID, { type: "busy" })

      step++
      if (step === 1) {
        await ensureTitle({
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
        const subagentAgent = await Agent.get(pendingTask.agent)
        // Slash/@ subtasks are started by the user, so skip agent approval (bypassAgentCheck). The child follows the
        // main session's mode and cannot nest subagents.
        const sessionNow = (await Session.get(sessionID)) ?? session
        const subagentRuleset = buildToolExecutionRuleset({
          agent: subagentAgent,
          session: sessionNow,
          permissionMode: effectivePermissionMode,
          child: true,
        })
        const subagentCtx: Tool.Context = {
          agent: pendingTask.agent,
          permissionMode: effectivePermissionMode,
          kind: effectivePermissionMode,
          messageID: assistantInfo.id,
          sessionID: sessionID,
          abort,
          callID: part.callID,
          extra: { bypassAgentCheck: true },
          messages: msgs,
          ruleset: subagentRuleset,
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
            await PermissionNext.ask({
              ...req,
              sessionID: sessionID,
              tool: { messageID: assistantInfo.id, callID: part.callID },
              ruleset: subagentRuleset,
            })
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
          permissionMode: effectivePermissionMode,
        })
        if (action === "blocked") break
        if (action !== "skip") continue
      }

      // normal processing
      const agent = await Agent.get(lastUserInfo.agent)
      const maxSteps = agent.steps ?? Infinity
      const isLastStep = step >= maxSteps
      msgs = await insertReminders({
        messages: msgs,
        session,
        mode: effectivePermissionMode,
      })

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
        permissionMode: effectivePermissionMode,
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

      const view = await SessionContextView.build({
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
          permissionMode: effectivePermissionMode,
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

      const resolvedTools = await resolveTools({
        agent,
        session,
        model,
        tools: lastUserInfo.tools,
        processor,
        bypassAgentCheck,
        messages: msgs,
        permissionMode: effectivePermissionMode,
        step,
      }).catch(async (error) => {
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
      })

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
          permissionMode: effectivePermissionMode,
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
        MemoryExtract.schedule({
          session,
          assistant: processor.message,
          model: lastUserInfo.model,
        })
        SessionMemory.schedule({
          session,
          assistant: processor.message,
          model: lastUserInfo.model,
          tokens: tokensFromUsage(processor.message.tokens),
        })
        AutoDream.schedule({
          session,
          assistant: processor.message,
          model: lastUserInfo.model,
        })
        break
      }

      if (result === "stop") {
        // Schedule memory extraction only for the final response without tool calls, so intermediate steps do not
        // fork extraction sessions.
        MemoryExtract.schedule({
          session,
          assistant: processor.message,
          model: lastUserInfo.model,
        })
        SessionMemory.schedule({
          session,
          assistant: processor.message,
          model: lastUserInfo.model,
          tokens: tokensFromUsage(processor.message.tokens),
        })
        AutoDream.schedule({
          session,
          assistant: processor.message,
          model: lastUserInfo.model,
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
          permissionMode: effectivePermissionMode,
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
    scope: SessionExecution.Scope | undefined,
    sessionID: string,
    controller: AbortController,
    self: SessionState,
  ) {
    return SessionExecution.bind(scope, {
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
    if (message.info.role !== "user") return
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
    self: SessionState
    loopPermissionMode?: PermissionMode.Value
    maxTurns?: number
  }) {
    const { sessionID, controller, self, loopPermissionMode, maxTurns } = input
    const abort = controller.signal
    let unbind = () => {}
    let completed: { callback: TurnCallback; result: Message.FullMsg } | undefined

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
                (await SessionExecution.run(nextPrompt.scope, () =>
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
        const result = await SessionExecution.run(self.activeCallback?.scope, () =>
          runTurn({
            sessionID,
            targetUserID: targetUser.info.id,
            abort,
            loopPermissionMode,
            maxTurns,
          }),
        )

        const cb = self.activeCallback
        self.activeCallback = undefined
        unbind()
        if (cb) {
          completed = { callback: cb, result }
        }
      }
    } catch (error) {
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
      self.running = false
      self.done.resolve()
      releaseOwner(sessionID, controller)
      completed?.callback.resolve(completed.result)
    }
  }

  export const loop = fn(LoopInput, async (input) => {
    const { sessionID, resume_existing } = input
    SessionExecution.check(sessionID)
    const scope = SessionExecution.current(sessionID)
    const loopPermissionMode = input.permissionMode ?? input.kind

    const controller = resume_existing ? undefined : start(sessionID)
    const self = state()[sessionID]

    if (controller && self) {
      self.running = true
      const ownerPromise = new Promise<Message.FullMsg>((resolve, reject) => {
        self.callbacks.push({ scope, resolve, reject })
      })

      void SessionExecution.run(undefined, () =>
        processSessionTurns({
          sessionID,
          controller,
          self,
          loopPermissionMode,
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

      void SessionExecution.run(undefined, () =>
        processSessionTurns({
          sessionID,
          controller: self.abort,
          self,
          loopPermissionMode,
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
    permissionMode?: PermissionMode.Value
    discovered: Set<string>
  }) {
    if (!input.trigger || !skillToolAvailable(input)) return undefined

    const ruleset = buildToolExecutionRuleset({
      agent: input.agent,
      session: input.session,
      permissionMode: input.permissionMode,
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
    permissionMode?: PermissionMode.Value
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
          permissionMode: input.permissionMode,
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
    permissionMode?: PermissionMode.Value
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
      permissionMode: input.permissionMode,
      auto: true,
    })
    return "compact"
  }

  async function lastModel(sessionID: string) {
    for await (const item of Message.stream(sessionID)) {
      if (item.info.role === "user" && item.info.model) return item.info.model
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
      // synthetic notification message without a permissionMode.
      permissionMode: latestRealUser?.info.permissionMode,
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
          item.info.role === "assistant" && message.info.id < item.info.id && isTurnSettled(item.info),
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
  function isChildToolSession(session: Session.Info, child?: boolean): boolean {
    return Boolean(session.parentID) || child === true
  }

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
  export async function modeOf(session: Session.Info, fallback?: PermissionMode.Value): Promise<PermissionMode.Value> {
    if (!session.parentID) return session.permissionMode ?? fallback ?? PermissionMode.DEFAULT
    const root = await Session.get(await Session.rootID(session.id)).catch(() => undefined)
    return root?.permissionMode ?? PermissionMode.DEFAULT
  }

  /**
   * Rule chain rebuilt before each tool execute (evaluate picks the last matching rule):
   *   permission mode defaults, then user config (agent.permission) and session rules, then read-only mode denials
   *   (all three from PermissionPolicy.ruleset), then agent hard limits (restrictedRules), then the nested subagent ban
   *   for child sessions.
   * Session grants live on the root session: the root's own are in session.permission; for child sessions the caller
   * passes the root's grants.
   */
  export function buildToolExecutionRuleset(input: {
    agent: Agent.Info
    session: Session.Info
    permissionMode?: PermissionMode.Value
    child?: boolean
    grants?: PermissionNext.Ruleset
  }): PermissionNext.Ruleset {
    const mode = input.permissionMode ?? PermissionMode.DEFAULT
    const user = PermissionNext.merge(input.agent.permission, input.grants ?? [], input.session.permission ?? [])
    const child = isChildToolSession(input.session, input.child)
    return PermissionNext.merge(
      PermissionPolicy.ruleset(mode, user),
      input.agent.profile?.restrictedRules ?? [],
      child ? PermissionNext.appendForbidNestedSubagentRule() : [],
    )
  }

  /** @internal Exported for testing */
  export async function resolveTools(input: {
    agent: Agent.Info
    model: Provider.Model
    session: Session.Info
    tools?: Record<string, boolean>
    processor: SessionProcessor.Info
    bypassAgentCheck: boolean
    messages: Message.FullMsg[]
    permissionMode?: PermissionMode.Value
    child?: boolean
    /**
     * Step number in the current turn. Only used to run tool discovery once, on step 1: the query does not change
     * within a turn and step 1's result is already persisted as a marker part, while CJK n-gram scoring with a long
     * query and many MCP candidates can take hundreds of milliseconds per run. Defaults to 1 for tests.
     */
    step?: number
  }) {
    using _ = log.time("resolveTools")
    const tools: Record<string, AITool> = {}

    const effectivePermissionMode = input.permissionMode ?? PermissionMode.DEFAULT
    const childSession = isChildToolSession(input.session, input.child)

    /**
     * Reads the latest Agent/Session before every actual tool call.
     * The ruleset and ctx.permissionMode / ctx.kind must share one source: after a live mode switch, commands, paths
     * outside the workspace and plan switches must be judged by the new mode, not the one captured by resolveTools.
     */
    async function liveExecution() {
      const [agentNext, sessionNext] = await Promise.all([Agent.get(input.agent.id), Session.get(input.session.id)])
      const agent = agentNext ?? input.agent
      const session = sessionNext ?? input.session
      const permissionMode = await modeOf(session, effectivePermissionMode)
      return {
        permissionMode,
        ruleset: buildToolExecutionRuleset({
          agent,
          session,
          permissionMode,
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
    function registerToolAbort(callID: string | undefined): { signal: AbortSignal | undefined; dispose: () => void } {
      const sessionState = state()[input.session.id]
      if (!sessionState || !callID) return { signal: undefined, dispose: () => {} }
      const childAbort = new AbortController()
      sessionState.toolAborts.set(callID, childAbort)
      const cascadeAbort = () => childAbort.abort()
      sessionState.abort.signal.addEventListener("abort", cascadeAbort, { once: true })
      const dispose = () => {
        sessionState.abort.signal.removeEventListener("abort", cascadeAbort)
        sessionState.toolAborts.delete(callID)
      }
      return { signal: childAbort.signal, dispose }
    }

    const context = (
      args: any,
      options: ToolExecutionOptions<unknown>,
      ruleset: PermissionNext.Ruleset,
      abortSignal?: AbortSignal,
      permissionMode: PermissionMode.Value = effectivePermissionMode,
    ): Tool.Context => {
      const ctx: Tool.Context = {
        sessionID: input.session.id,
        abort: abortSignal ?? options.abortSignal!,
        messageID: input.processor.message.id,
        callID: options.toolCallId,
        extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck },
        agent: input.agent.id,
        permissionMode,
        kind: permissionMode,
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
          await PermissionNext.ask({
            ...req,
            sessionID: input.session.id,
            ...(await origin()),
            tool: { messageID: input.processor.message.id, callID: options.toolCallId },
            ruleset,
          })
        },
      }
      return ctx
    }

    const pool = new Set(input.agent.profile?.availableTools ?? STANDARD_TOOL_POOL)
    const allowMcp = pool.has("mcp")

    // The MCP tool list does not change within one resolveTools call, so fetch it once instead of repeating listTools
    // round trips. Agents whose pool lacks "mcp" (narrow pools such as compaction or memory-extractor) skip it.
    const mcpTools = allowMcp ? await MCP.tools() : {}
    // Server names for expandMcpServerActivation come from the clients actually connected in this process, not every
    // configured server: tools of disabled or failed servers are not in mcpTools anyway. clients() only holds live
    // connections and is the same source MCP.tools() uses.
    const mcpServerNames = allowMcp ? Object.keys(await MCP.clients()) : []
    const standardTools = await ToolRegistry.tools(
      { modelID: input.model.api.id, providerID: input.model.providerID },
      input.agent,
    )

    // Deferred loading: deferred tools stay out of the tools array, saving the per-turn token cost of their full
    // description and parameter schema; tool_search only lists their names and summaries. buildDeferredPlan is shared
    // with context-view.resolveToolStats so /context counts the same tool set that is injected here.
    const deferred = buildDeferredPlan({
      standard: standardTools,
      mcp: mcpTools,
      deferredStandardIds: computeDeferred(input.agent),
      messages: input.messages,
      disabled: (id) => input.tools?.[id] === false,
    })

    // Tools removed outright: child sessions cannot nest workflows. Computed here because auto-activation must skip
    // them too; activating a tool that is later removed would point the model at a tool that does not exist.
    const physicallyHidden = new Set<string>()
    if (childSession) physicallyHidden.add("workflow_run")

    // Map the query to tools worth activating. Otherwise deferred tools only show up by name in the tool_search
    // description and the model must find them itself; e.g. asked to "use a workflow for the research", the model read
    // "workflow" as "work step by step", used todowrite, and never activated workflow_run.
    //
    // Two stages, both run only while some tools are still inactive this turn:
    // - Stage A (deterministic scoring, on by default): strong matches are activated right away and get their full
    //   schema this turn. Activation through tool_search only takes effect next turn (there is no same-turn expansion
    //   like Anthropic's tool_reference), and that round trip is expensive, so confident matches skip it.
    // - Stage B (small model selection, off by default): only runs with many candidates (mostly many MCP tools);
    //   timeouts and failures select nothing and never block the turn.
    const autoActivated: string[] = []
    if (deferred.hasPending && (input.step ?? 1) === 1 && (await ToolDiscovery.autoActivateEnabled())) {
      const query = SkillSearch.latestUserText(input.messages)
      const candidates = deferred.summaries.filter(
        (item) => !deferred.activated.has(item.id) && !physicallyHidden.has(item.id),
      )
      const matches = ToolDiscovery.rank({ candidates, query })
      // Activate MCP servers as a whole: a strong match on any tool of a server activates all of its pending tools.
      // The top-2 cap in autoActivateIds once left a knowledge base server with only two write tools, so the model
      // concluded it could not query and abandoned it. With the whole server visible, the model picks query, write
      // and admin tools from their descriptions. serverNames are the connected clients (mcpServerNames above), the
      // same source as mcpIds.
      autoActivated.push(
        ...ToolDiscovery.expandMcpServerActivation({
          selected: ToolDiscovery.autoActivateIds(matches),
          candidates,
          mcpIds: new Set(Object.keys(mcpTools)),
          serverNames: mcpServerNames,
        }),
      )

      // Stage B: ask the small model only when Stage A found no strong match and the candidate pool is large (mostly
      // many MCP tools). The threshold uses all pending candidates, not Stage A's shortlist; otherwise a case like
      // 50 candidates with only 5 weak keyword hits, which most needs the small model, would be filtered out.
      if (
        autoActivated.length === 0 &&
        candidates.length >= ToolDiscoveryRerank.MIN_CANDIDATES &&
        (await ToolDiscovery.rerankEnabled())
      ) {
        const picked = await ToolDiscoveryRerank.select({
          query,
          // Send the weak matches (sorted by relevance) if any, else all candidates (truncated internally).
          candidates: matches.length > 0 ? matches.map((match) => match.tool) : candidates,
          fallbackProviderID: input.model.providerID,
        }).catch(() => [])
        autoActivated.push(...picked.filter((id) => !physicallyHidden.has(id)))
      }

      // isPending reads this set, so the loop below builds the newly activated tools normally.
      for (const id of autoActivated) deferred.activated.add(id)
    }

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
          const abort = registerToolAbort(options.toolCallId)
          const ctx = context(args, options, live.ruleset, abort.signal, live.permissionMode)
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
        const abort = registerToolAbort(opts.toolCallId)
        const ctx = context(args, opts, live.ruleset, abort.signal, live.permissionMode)
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

          result = await execute(args, opts)

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

    const mcpIds = new Set(Object.keys(mcpTools))
    const dynamic = await ToolRegistry.dynamicIds()
    // Visibility of standard tools, skill included, is decided by standardToolAvailable (pool.has(id)).

    for (const key of Object.keys(tools)) {
      if (key === "StructuredOutput") continue
      if (key === "invalid") continue
      if (mcpIds.has(key)) {
        if (!allowMcp) delete tools[key]
        continue
      }
      const enabled =
        standardToolAvailable({ id: key, agent: input.agent, tools: input.tools }) ||
        (pool.has("plugin") && dynamic.has(key) && input.tools?.[key] !== false)
      if (!enabled) delete tools[key]
    }

    // Auto mode never interrupts the user: drop question and plan_enter (plan mode needs human approval).
    if (effectivePermissionMode === "auto") {
      delete tools.question
      delete tools.plan_enter
    }
    // Plan (read-only) mode only offers plan_exit; other modes have no plan_exit.
    if (effectivePermissionMode === "readonly") delete tools.plan_enter
    else delete tools.plan_exit
    // Child sessions cannot nest: remove subagent from the visible tools (matching the deny at the end of the rule
    // chain). Plan mode belongs to the root session only.
    if (childSession) {
      delete tools.subagent
      delete tools.workflow_run
      delete tools.plan_enter
      delete tools.plan_exit
    }

    // Inject the tool_search meta tool after pool filtering and child session removal, so standardToolAvailable does
    // not drop it as a non-standard tool (like StructuredOutput, it is not in ToolRegistry or the default pool).
    if (deferred.summaries.length > 0) {
      // Hidden tools (physicallyHidden, e.g. workflow_run) would be removed even if activated, so drop them from the
      // deferred list to avoid the model activating a tool whose call then fails. Also drop activated tools that were
      // removed (missing from tools); keep inactive ones, which are not in tools yet.
      const visible = deferred.summaries.filter(
        (t) => !physicallyHidden.has(t.id) && (!deferred.activated.has(t.id) || tools[t.id] !== undefined),
      )
      // Inject only while some tool is still inactive; once everything is active tool_search is useless and only costs
      // description and schema tokens. The list still includes activated tools so re-activating one is a harmless
      // no-op rather than an error.
      if (visible.some((t) => !deferred.activated.has(t.id))) {
        tools["tool_search"] = buildToolSearchTool({
          deferred: visible,
          activated: deferred.activated,
          // Loaded tools: a bare name or an already loaded tool is a no-op, not an error.
          loaded: new Set(Object.keys(tools)),
        })
      }
    }

    // mcpIds and dynamicToolIds are passed on to LLM.stream so llm.ts does not call MCP.tools() or
    // ToolRegistry.dynamicIds() again. autoActivated lists tools activated by Stage A/B this turn; the caller must
    // write a marker part for them, or scanActivatedTools will not see them next turn and they revert to deferred.
    return { tools, mcpIds, dynamicToolIds: dynamic, autoActivated }
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

  async function createUserMessage(input: PromptInput, commandSource?: Message.UserInfo["commandSource"]) {
    SessionExecution.check(input.sessionID)
    const selection = await SessionExecution.wait(async () => PromptMode.resolve(input))
    const agent = await SessionExecution.wait(async () => Agent.get(selection.agentID))
    if (!agent) throw new Error(`Agent not found: ${selection.agentID}`)

    const model = input.model ?? agent.model ?? (await SessionExecution.wait(async () => lastModel(input.sessionID)))
    if (input.model) await Provider.remember(input.model)
    const full = await SessionExecution.wait(async () =>
      Provider.getModel(model.providerID, model.modelID).catch(() => undefined),
    )
    const history = await SessionExecution.wait(async () => Session.messages({ sessionID: input.sessionID }))
    const picked = history.some(
      (message) =>
        message.info.role === "user" &&
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
      permissionMode: selection.permissionMode,
      metadata: input.metadata,
      model,
      system: input.system,
      commandSource,
      format: input.format,
      variant,
    }
    using _ = defer(() => ContextAttach.clear(info.id))
    await SessionExecution.wait(async () => RuleSession.noteUserTurn(input.sessionID, info.id))

    const parts = await SessionExecution.wait(async () =>
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
                const resourceContent = await SessionExecution.wait(async () => MCP.readResource(clientName, uri))
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
                  ? await SessionExecution.wait(async () =>
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
                const stat = await SessionExecution.wait(async () => fs.stat(filepath).catch(() => undefined))

                if (stat?.isDirectory()) {
                  part.mime = "application/x-directory"
                }

                // @-mentioned rule files: manual / agent-requested rules are pinned to the session; always / auto
                // skip the YAML dump. RulesPrompt.active puts the body into user-context, not the user message.
                if (part.mime === "text/plain") {
                  const action = await SessionExecution.wait(async () =>
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
                  await SessionExecution.wait(async () => RuleSession.recordFile(input.sessionID, filepath, info.id))
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
                      const symbols = await SessionExecution.wait(async () =>
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

                  await SessionExecution.wait(async () =>
                    ReadTool.init()
                      .then(async (t) => {
                        const model = await SessionExecution.wait(async () =>
                          Provider.getModel(info.model.providerID, info.model.modelID),
                        )
                        // Pre-read of a mentioned file: bypassCwdCheck skips directory and permission checks; no
                        // ruleset.
                        const readCtx: Tool.Context = {
                          sessionID: input.sessionID,
                          abort: new AbortController().signal,
                          agent: agent.id,
                          permissionMode: PermissionMode.DEFAULT,
                          kind: PermissionMode.DEFAULT,
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
                        const result = await SessionExecution.wait(async () => t.execute(args, readCtx))
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
                    permissionMode: PermissionMode.DEFAULT,
                    kind: PermissionMode.DEFAULT,
                    messageID: info.id,
                    extra: { bypassCwdCheck: true },
                    messages: [],
                    ruleset: [],
                    metadata: async () => {},
                    ask: async () => {},
                  }
                  const result = await SessionExecution.wait(async () =>
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
                await SessionExecution.wait(async () => RuleSession.recordFile(input.sessionID, filepath, info.id))
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
                      Buffer.from(await SessionExecution.wait(async () => Filesystem.readBytes(file))).toString(
                        "base64",
                      ),
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

    await SessionExecution.wait(async () =>
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
    SessionExecution.onCancel(SessionExecution.current(info.sessionID), async () => {
      await persisted.promise
      await settleCancelledPrompt({ info, parts })
    })
    try {
      SessionExecution.check(info.sessionID)
      // Finish each in-flight storage write before reconciling cancellation. The
      // outer preparation remains abortable, but its late write cannot resurrect
      // an unanswered user message after the cancellation ACK.
      await Session.updateInfo(info)
      SessionExecution.check(info.sessionID)
      for (const part of parts) {
        await Session.updatePart(part)
        SessionExecution.check(info.sessionID)
      }
    } finally {
      persisted.resolve()
    }
  }

  /**
   * System reminders for plan (read-only) mode: the full workflow on entry, a plan_exit nudge while staying, and an
   * instruction to execute the plan on leaving.
   */
  async function insertReminders(input: {
    messages: Message.FullMsg[]
    session: Session.Info
    mode: PermissionMode.Value
  }) {
    const { messages, session, mode } = input

    // Find the last user message
    const lastUserMessage = messages.findLast((m) => m.info.role === "user")
    if (!lastUserMessage || lastUserMessage.info.role !== "user") return messages

    // Find the last assistant message
    const assistantMessage = messages.findLast((msg) => msg.info.role === "assistant")

    // Type-safe access to user message properties
    const userInfo = lastUserMessage.info as Message.UserInfo
    const userParts = lastUserMessage.parts

    // Mode of the previous reply: the mode on the user message it answered.
    const lastParent =
      assistantMessage?.info.role === "assistant"
        ? messages.find((msg) => msg.info.id === (assistantMessage.info as Message.AssistantInfo).parentID)
        : undefined
    const lastMode =
      lastParent?.info.role === "user" ? PermissionMode.normalize(lastParent.info.permissionMode) : undefined
    // Only check for the plan file when this or the previous turn is read-only, to avoid extra IO on normal turns.
    const mayNeedPlanFile = mode === "readonly" || lastMode === "readonly"
    const plan = Session.plan(session)
    const planExists = mayNeedPlanFile ? await Filesystem.isFile(plan) : false
    const reminderKind = resolvePlanReminderKind({
      planModeEnabled: Flag.MERAKCODE_PLAN_MODE,
      mode,
      lastMode,
      planExists,
      child: Boolean(session.parentID),
    })

    // Switching from plan mode to build mode
    if (reminderKind === "build-switch") {
      const part = await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: userInfo.id,
        sessionID: userInfo.sessionID,
        type: "text",
        text: BUILD_SWITCH + "\n\n" + `A plan file exists at ${plan}. You should execute on the plan defined within it`,
        synthetic: true,
      })
      userParts.push(part)
      return messages
    }

    // Entering plan mode
    if (reminderKind === "enter") {
      if (!planExists) await fs.mkdir(path.dirname(plan), { recursive: true })
      const part = await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: userInfo.id,
        sessionID: userInfo.sessionID,
        type: "text",
        text: `<system-reminder>
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received.

## Plan File Info:
${planExists ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.` : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase you should only use the explore subagent type.

1. Focus on understanding the user's request and the code associated with their request

2. **Launch up to 3 explore agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.
   - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change.
   - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before implementing.
   - Quality over quantity - 3 agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)
   - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigates testing patterns

3. After exploring the code, use the question tool to clarify ambiguities in the user request up front.

### Phase 2: Design
Goal: Design an implementation approach.

Launch general agent(s) to design the implementation based on the user's intent and your exploration results from Phase 1.

You can launch up to 1 agent(s) in parallel.

**Guidelines:**
- **Default**: Launch at least 1 Plan agent for most tasks - it helps validate your understanding and consider alternatives
- **Skip agents**: Only for truly trivial tasks (typo fixes, single-line changes, simple renames)

Examples of when to use multiple agents:
- The task touches multiple parts of the codebase
- It's a large refactor or architectural change
- There are many edge cases to consider
- You'd benefit from exploring different approaches

Example perspectives by task type:
- New feature: simplicity vs performance vs maintainability
- Bug fix: root cause vs workaround vs prevention
- Refactoring: minimal change vs clean architecture

In the agent prompt:
- Provide comprehensive background context from Phase 1 exploration including filenames and code path traces
- Describe requirements and constraints
- Request a detailed implementation plan

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files identified by agents to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use question tool to clarify any remaining questions with the user

### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- Include only your recommended approach, not all alternatives
- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively
- Include the paths of critical files to be modified
- Include a verification section describing how to test the changes end-to-end (run the code, use MCP tools, run tests)

### Phase 5: Call plan_exit tool
At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call plan_exit to indicate to the user that you are done planning.
This is critical - your turn should only end with either asking the user a question or calling plan_exit. Do not stop unless it's for these 2 reasons.

**Important:** Use question tool to clarify requirements/approach, use plan_exit to request plan approval. Do NOT use question tool to ask "Is this plan okay?" - that's what plan_exit does.

NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.
`,
        synthetic: true,
      })
      userParts.push(part)
      return messages
    }

    // Still in plan mode with a saved plan: nudge plan_exit so a request to start does not edit project files directly.
    if (reminderKind === "stay-call-exit") {
      const part = await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: userInfo.id,
        sessionID: userInfo.sessionID,
        type: "text",
        text: planStayCallExitReminder(plan),
        synthetic: true,
      })
      userParts.push(part)
      return messages
    }

    return messages
  }

  export const ShellInput = z.object({
    sessionID: Identifier.schema("session"),
    agent: z.string(),
    permissionMode: PermissionMode.Schema.optional(),
    /** @deprecated Use permissionMode. */
    kind: PermissionMode.Schema.optional(),
    model: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
      })
      .optional(),
    command: z.string(),
  })
  export type ShellInput = z.infer<typeof ShellInput>
  export async function shell(input: ShellInput) {
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
        cancel(input.sessionID)
      } else {
        // Otherwise, trigger the session loop to process queued items
        loop({ sessionID: input.sessionID, resume_existing: true }).catch((error) => {
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
      permissionMode: input.permissionMode ?? input.kind,
      model: {
        providerID: model.providerID,
        modelID: model.modelID,
      },
    }
    await Session.updateInfo(userInfo)
    await persistSessionPermissionMode(session, userInfo.permissionMode)
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
    permissionMode: PermissionMode.Schema.optional(),
    /** @deprecated Use permissionMode. */
    kind: PermissionMode.Schema.optional(),
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
      const cmdAgent = await SessionExecution.wait(async () => Agent.get(commandAgent))
      if (cmdAgent?.model) {
        return cmdAgent.model
      }
    }
    if (input.model) return Provider.parseModel(input.model)
    return await SessionExecution.wait(async () => lastModel(input.sessionID))
  }

  async function getCommandModel(input: CommandInput, command: Command.Info) {
    const model = await SessionExecution.wait(async () => resolveCommandModel(input, command))
    try {
      return {
        ref: model,
        full: await SessionExecution.wait(async () => Provider.getModel(model.providerID, model.modelID)),
      }
    } catch (e) {
      SessionExecution.check(input.sessionID)
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
    const agent = await SessionExecution.wait(async () => Agent.get(agentID))
    if (agent) return agent

    const available = await SessionExecution.wait(async () =>
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
    SessionStatus.finishSync(sessionID)
  }

  /**
   * When a synchronous command has a follow-up task, injects the command output into the follow-up LLM system prompt
   * (the ignored report never reaches the context view).
   */
  function buildSyncFollowupSystem(commandName: string, output: string) {
    return `The user just ran the /${commandName} command. Its output is below; use it to answer the user's follow-up questions:\n\n${output}`
  }

  async function contextCommand(input: CommandInput, command: Command.Info, agentID: string) {
    SessionExecution.check(input.sessionID)
    assertNotBusy(input.sessionID)
    const [{ ref: commandModel, full: model }, agent, messages] = await SessionExecution.wait(async () =>
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
    await SessionExecution.wait(async () => Session.touch(input.sessionID))

    const view = await SessionExecution.wait(async () =>
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
    const lang = await SessionExecution.wait(() => Text.lang())
    const report = SessionContextReport.format({ view, agent, model, lang })
    const completed = Date.now()
    const assistantInfo = (await SessionExecution.wait(async () =>
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
    const part = await SessionExecution.wait(async () =>
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
   * - System: skill commands load the full skill so the model can introduce it and ask what the user needs.
   */
  export async function resolveCommandInjection(input: {
    command: string
    arguments: string
  }): Promise<{ template: string; system: string | undefined }> {
    SessionExecution.check()
    const raw = input.arguments.match(argsRegex) ?? []
    const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))
    const command = await SessionExecution.wait(async () => Command.get(input.command))
    const templateCommand = command ? await SessionExecution.wait(async () => command.template) : ""

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
      const results = await SessionExecution.wait(async () =>
        Promise.all(
          shell.map(async ([, cmd]) => {
            try {
              return await SessionExecution.wait(async () => (await Shell.run(cmd)).text())
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
      command?.source === "skill" ? await SessionExecution.wait(async () => Skill.get(command.name)) : undefined
    const system = skill
      ? `You have loaded the "${skill.name}" skill. Its full content follows:
${skill.content}

In the user's language, give the user a friendly overview of this skill and what it does (use a clear structure, such as core concepts, key principles, and how to use it), then ask what they would like to use this skill for.`
      : undefined

    return { template, system }
  }

  export async function command(input: CommandInput): Promise<Message.FullMsg> {
    if (SessionExecution.current() && !SessionExecution.current(input.sessionID)) {
      return SessionExecution.run(undefined, () => SessionRunner.command(input))
    }
    SessionExecution.check(input.sessionID)
    log.info("command", { sessionID: input.sessionID, requestID: SessionExecution.current(input.sessionID)?.id })
    const requestedAgent = input.agent ?? (await SessionExecution.wait(async () => Agent.defaultAgent()))
    const command = await SessionExecution.wait(async () => Command.get(input.command))
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
      const sync = await SessionExecution.wait(async () => contextCommand(input, command, agentID))
      const task = input.arguments.trim()
      if (!task) {
        finishSyncCommand(input.sessionID)
        return sync
      }

      // contextCommand already resolved the agent and model: reuse agentID and resolve the model ref the same way.
      const report = sync.parts.find((part) => part.type === "text") as Message.TextPart | undefined
      const { ref: commandModel } = await SessionExecution.wait(async () => getCommandModel(input, command))

      return prompt({
        sessionID: input.sessionID,
        model: commandModel,
        agent: agentID,
        permissionMode: input.permissionMode ?? input.kind,
        parts: [{ type: "text", text: task }],
        variant: input.variant,
        metadata: input.metadata,
        system: buildSyncFollowupSystem(input.command, report?.text ?? ""),
      })
    }

    const { template, system } = await SessionExecution.wait(async () => resolveCommandInjection(input))

    const { ref: commandModel } = await SessionExecution.wait(async () => getCommandModel(input, command))

    // getCommandAgent already throws AgentNotFoundError listing the available agents.
    const agent = await SessionExecution.wait(async () => getCommandAgent(input, agentID))

    const expandedParts = await SessionExecution.wait(async () => resolvePromptParts(template))
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
      ? (input.agent ?? (await SessionExecution.wait(async () => Agent.defaultAgent())))
      : agentID
    const userModel = isSubtask
      ? input.model
        ? Provider.parseModel(input.model)
        : await SessionExecution.wait(async () => lastModel(input.sessionID))
      : commandModel

    await SessionExecution.wait(async () =>
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

    const result = (await SessionExecution.wait(async () =>
      promptInternal(
        {
          sessionID: input.sessionID,
          messageID: input.messageID,
          model: userModel,
          agent: userAgent,
          permissionMode: input.permissionMode ?? input.kind,
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

    return result
  }

  async function ensureTitle(input: {
    session: Session.Info
    history: Message.FullMsg[]
    providerID: string
    modelID: string
  }) {
    if (input.session.parentID) return
    if (!Session.isDefaultTitle(input.session.title)) return

    // Find first non-synthetic user message
    const firstRealUserIdx = input.history.findIndex(
      (m) => m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic),
    )
    if (firstRealUserIdx === -1) return

    const isFirst =
      input.history.filter((m) => m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic))
        .length === 1
    if (!isFirst) return

    // Gather all messages up to and including the first real user message for context
    // This includes any shell/subtask executions that preceded the user's first prompt
    const contextMessages = input.history.slice(0, firstRealUserIdx + 1)
    const firstRealUser = contextMessages[firstRealUserIdx]

    // For subtask-only messages (from command invocations), extract the prompt directly
    // since toModelMessage converts subtask parts to generic "The following tool was executed by the user"
    const subtaskParts = firstRealUser.parts.filter((p) => p.type === "subtask") as Message.SubtaskPart[]
    const hasOnlySubtaskParts = subtaskParts.length > 0 && firstRealUser.parts.every((p) => p.type === "subtask")

    const agent = await Agent.get("title")
    if (!agent) return
    const model = await iife(async () => {
      if (agent.model) return await Provider.getModel(agent.model.providerID, agent.model.modelID)
      return (
        (await Provider.getSmallModel(input.providerID)) ?? (await Provider.getModel(input.providerID, input.modelID))
      )
    })
    const result = await LLM.stream({
      agent,
      user: firstRealUser.info as Message.UserInfo,
      system: [],
      small: true,
      tools: {},
      model,
      abort: new AbortController().signal,
      sessionID: input.session.id,
      retries: 2,
      messages: [
        {
          role: "user",
          content: "Generate a title for this conversation:\n",
        },
        ...(hasOnlySubtaskParts
          ? [{ role: "user" as const, content: subtaskParts.map((p) => p.prompt).join("\n") }]
          : await Message.toModelMessages(contextMessages, model)),
      ],
    })
    const text = await Promise.resolve(result.text).catch((err) =>
      log.error("failed to generate title", { error: err }),
    )
    if (text)
      return Session.update(
        input.session.id,
        (draft) => {
          const cleaned = text
            .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line.length > 0)
          if (!cleaned) return

          const title = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
          draft.title = title
        },
        { touch: false },
      )
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
