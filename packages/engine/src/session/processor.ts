import { parse as parsePartialJson, Allow } from "partial-json"
import { Message } from "./message"
import { Log } from "@merakcode/log/logger"
import { Identifier } from "@merakcode/util/id"
import { Session } from "."
import { Snapshot } from "../snapshot"
import { SessionSummary } from "./summary"
import { Bus } from "../bus"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"

import { Plugin } from "../plugin"
import { Provider } from "../provider/provider"
import { LLM } from "./llm"
import { Config } from "../config/config"
import { SessionCompaction } from "./compaction"
import { PermissionNext } from "../permission/next"
import { Question } from "../question"

/** Throttle (ms) for persisting tool-input-delta, matching text-delta, so SSE and the store are not flooded */
const TOOL_INPUT_FLUSH_MS = 50

/**
 * At the end of a turn, detects reasoning parts that never got time.end because the provider sent no reasoning-end.
 * These need a bounded end; otherwise clients fall back to Date.now() and the reasoning duration keeps growing on
 * every render. Returns a type guard so callers can narrow.
 */
export function needsReasoningEndBackfill(part: Message.Part): part is Message.ReasoningPart {
  return part.type === "reasoning" && part.time.end === undefined
}

/**
 * Builds the persisted tool-result state. The invalid placeholder tool is a failure for the user but still a
 * successful result for the model (execute does not throw).
 */
export function persistToolResult(event: {
  tool: string
  input: Record<string, unknown>
  output: string
  title: string
  metadata: Record<string, unknown>
  start: number
  end: number
  attachments?: Message.FilePart[]
}): { state: Message.ToolStateCompleted | Message.ToolStateError; countSuccess: boolean } {
  if (event.tool === "invalid") {
    const intended =
      typeof event.input.tool === "string"
        ? event.input.tool
        : typeof event.metadata.intendedTool === "string"
          ? event.metadata.intendedTool
          : undefined
    return {
      state: {
        status: "error",
        input: event.input,
        error: event.output,
        metadata: {
          ...event.metadata,
          errorKind: "invalid_arguments",
          invalid: true,
          intendedTool: intended,
        },
        time: { start: event.start, end: event.end },
      },
      countSuccess: false,
    }
  }
  return {
    state: {
      status: "completed",
      input: event.input,
      output: event.output,
      title: event.title,
      metadata: event.metadata,
      time: { start: event.start, end: event.end },
      attachments: event.attachments,
    },
    countSuccess: true,
  }
}

/** Leniently parses tool input from streamed raw JSON, so the UI can show fields like filePath while pending */
export function parseToolInputPartial(raw: string): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try {
    const parsed = parsePartialJson(raw, Allow.ALL)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * Appended to the tool-result output when the same call repeats past the threshold, nudging the model to change
 * approach without prompting the user.
 */
const DOOM_LOOP_REMINDER =
  "\n\n<system-reminder>" +
  "You have called the same tool with identical arguments 3 times in a row. This usually means the current approach is not working. " +
  "Stop repeating the call now and try a different approach based on the latest tool results." +
  "</system-reminder>"

export namespace SessionProcessor {
  /**
   * Outbound moderation of a completed message.
   *
   * Joins **all text parts** of the message into one text and passes it to the
   * `experimental.message.complete.transform` hook. If a plugin rewrites it, all existing text parts are cleared and
   * the result is written as a new part. If no plugin rewrites it, the part structure is left untouched, so consumers
   * without a moderation plugin see no change.
   *
   * The full text is used instead of per-part checks because `experimental.text.complete` fires on each part's
   * text-end and cannot catch content that is only a violation when the parts are combined.
   *
   * The engine makes **no moderation decisions** itself; it only triggers the hook and persists the result. If the
   * hook throws, `Plugin.trigger` catches it and marks the plugin degraded, and the text stays unchanged (fail-open).
   *
   * @internal Exported for focused regression tests.
   */
  export async function finalizeAssistantText(input: { sessionID: string; messageID: string }) {
    const messages = await Session.messages({ sessionID: input.sessionID })
    const target = messages.find((m) => m.info.id === input.messageID)
    if (!target) return
    const textParts = target.parts.filter((part) => part.type === "text")
    const fullText = textParts.map((part) => part.text).join("")
    if (!fullText) return

    const { text } = await Plugin.trigger(
      "experimental.message.complete.transform",
      { sessionID: input.sessionID, messageID: input.messageID, final: true as const },
      { text: fullText },
    )
    if (text === fullText) return

    // Clear every original part: any leftover fragment would itself be a leak
    for (const part of textParts) {
      await Session.updatePart({ ...part, text: "" }).catch(() => {})
    }
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: input.messageID,
      sessionID: input.sessionID,
      type: "text",
      text,
      time: { start: Date.now(), end: Date.now() },
    }).catch(() => {})
  }

  const DOOM_LOOP_THRESHOLD = 3
  const log = Log.create({ service: "session.processor" })

  export type Info = Awaited<ReturnType<typeof create>>
  export type Result = Awaited<ReturnType<Info["process"]>>

  export function create(input: {
    assistantInfo: Message.AssistantInfo
    sessionID: string
    model: Provider.Model
    abort: AbortSignal
  }) {
    const toolcalls: Record<string, Message.ToolPart> = {}
    const completedToolcalls: Record<string, Message.ToolPart> = {}
    /** callIDs that hit the repeated-call threshold; their tool-result gets the reminder appended */
    const doomLoopFlagged = new Set<string>()
    /** Throttled tool-input-delta flush timers (callID -> timer) */
    const toolInputFlushTimers: Record<string, ReturnType<typeof setTimeout>> = {}
    let snapshot: string | undefined
    let attempt = 0
    let needsCompaction = false
    /** Set when a tool execute returns stop:true; process() returns "stop" after the stream ends normally */
    let stopTurn = false
    /**
     * Number of tools the user rejected in this stream; with successToolCount it decides whether the agent loop
     * continues after a partial rejection
     */
    let rejectedCount = 0
    let successToolCount = 0

    const cancelToolInputFlush = (callID: string) => {
      const timer = toolInputFlushTimers[callID]
      if (!timer) return
      clearTimeout(timer)
      delete toolInputFlushTimers[callID]
    }

    /** Persists the accumulated raw/input now; called by the timer and by tool-input-end */
    const flushToolInputPart = async (callID: string) => {
      cancelToolInputFlush(callID)
      const match = toolcalls[callID]
      if (!match || match.state.status !== "pending") return
      const part = await Session.updatePart(match)
      toolcalls[callID] = part as Message.ToolPart
    }

    /** Clears all pending flush timers; called on retry and on normal completion */
    const cancelAllToolInputFlush = () => {
      for (const callID of Object.keys(toolInputFlushTimers)) cancelToolInputFlush(callID)
    }

    const scheduleCompaction = async (error: ReturnType<typeof Message.fromError>) => {
      if (!Message.ContextOverflowError.isInstance(error)) return false
      if (input.assistantInfo.summary) return false

      log.info("context overflow, scheduling compaction", {
        sessionID: input.sessionID,
        modelID: input.model.id,
        providerID: input.model.providerID,
      })
      await SessionCompaction.prune({ sessionID: input.sessionID }).catch((prune) =>
        log.warn("context overflow prune failed", {
          sessionID: input.sessionID,
          error: prune,
        }),
      )
      needsCompaction = true
      return true
    }

    const retryError = async (error: ReturnType<typeof Message.fromError>) => {
      const retry = SessionRetry.retryable(error)
      if (retry === undefined) return false

      // Cap retries so persistent retryable errors (429, overloaded) do not loop forever in while(true). Once the cap
      // is hit, return false so handleStreamError calls publishError, which persists the error and sets idle.
      if (attempt >= SessionRetry.RETRY_MAX_ATTEMPTS) {
        log.warn("retry attempts exhausted, giving up", {
          sessionID: input.sessionID,
          attempt,
          error: error.name,
        })
        return false
      }

      attempt++
      const delay = SessionRetry.delay(attempt, Message.APIError.isInstance(error) ? error : undefined)
      SessionStatus.set(input.sessionID, {
        type: "retry",
        attempt,
        message: retry,
        next: Date.now() + delay,
      })
      await SessionRetry.sleep(delay, input.abort).catch(() => {})
      cancelAllToolInputFlush()
      return true
    }

    const publishError = (error: ReturnType<typeof Message.fromError>) => {
      input.assistantInfo.error = error
      // Set idle before publishing the error so session.error arrives after state.busy is false; otherwise the WebView
      // reducer's busy guard drops it (the TUI and web clients have no such guard, so the order does not matter there)
      SessionStatus.set(input.sessionID, { type: "idle" })
      Bus.publish(Session.Event.Error, {
        sessionID: input.assistantInfo.sessionID,
        error: input.assistantInfo.error,
      })
    }

    const handleStreamError = async (error: unknown) => {
      // User stop: normalize to a standard MessageAbortedError so clients treat it as an interrupt, not an error
      // (no error banner, toast or unread dot).
      if (input.abort.aborted) {
        input.assistantInfo.error = new Message.AbortedError({ message: "Operation aborted by user" }).toObject()
        Bus.publish(Session.Event.Error, {
          sessionID: input.assistantInfo.sessionID,
          error: input.assistantInfo.error,
        })
        SessionStatus.set(input.sessionID, { type: "idle" })
        return "handled"
      }

      log.error("process", {
        error,
        stack: error instanceof Error ? error.stack : undefined,
      })
      const parsed = Message.fromError(error, { providerID: input.model.providerID })
      if (await scheduleCompaction(parsed)) return "handled"
      if (await retryError(parsed)) return "retry"
      publishError(parsed)
      return "handled"
    }

    const result = {
      get message() {
        return input.assistantInfo
      },
      partFromToolCall(toolCallID: string) {
        return toolcalls[toolCallID]
      },
      async updateToolCallMetadata(toolCallID: string, val: { title?: string; metadata?: Record<string, any> }) {
        const match = completedToolcalls[toolCallID]
        if (!match || match.state.status !== "completed") return false
        const updated = await Session.updatePart({
          ...match,
          state: {
            ...match.state,
            title: val.title ?? match.state.title,
            metadata: val.metadata ?? match.state.metadata,
          },
        })
        completedToolcalls[toolCallID] = updated as Message.ToolPart
        return true
      },
      async process(streamInput: LLM.StreamInput) {
        log.info("process")
        needsCompaction = false
        stopTurn = false
        rejectedCount = 0
        successToolCount = 0
        const shouldBreak = (await Config.get()).experimental?.continue_loop_on_deny !== true
        while (true) {
          try {
            let currentText: Message.TextPart | undefined
            let reasoningMap: Record<string, Message.ReasoningPart> = {}

            // Take the snapshot before calling the model: if the model calls a tool right away, the AI SDK runs it
            // before start-step is handled here, and a later snapshot would miss those file changes on undo
            snapshot ??= await Snapshot.track(input.sessionID)

            const stream = await LLM.stream(streamInput)

            for await (const value of stream.stream) {
              input.abort.throwIfAborted()
              switch (value.type) {
                case "start":
                  SessionStatus.set(input.sessionID, { type: "busy" })
                  // Record the context breakdown only for the first request of this assistant message, so later steps
                  // and retries do not overwrite it
                  if (stream.contextBreakdown && !input.assistantInfo.contextBreakdown) {
                    input.assistantInfo.contextBreakdown = stream.contextBreakdown
                    await Session.updateInfo(input.assistantInfo)
                  }
                  break

                case "reasoning-start":
                  if (value.id in reasoningMap) {
                    continue
                  }
                  reasoningMap[value.id] = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantInfo.id,
                    sessionID: input.assistantInfo.sessionID,
                    type: "reasoning",
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  break

                case "reasoning-delta":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text += value.text
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    if (part.text) await Session.updatePart({ part, delta: value.text })
                  }
                  break

                case "reasoning-end":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text = part.text.trimEnd()

                    part.time = {
                      ...part.time,
                      end: Date.now(),
                    }
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    await Session.updatePart(part)
                    delete reasoningMap[value.id]
                  }
                  break

                case "tool-input-start":
                  const part = await Session.updatePart({
                    id: toolcalls[value.id]?.id ?? Identifier.ascending("part"),
                    messageID: input.assistantInfo.id,
                    sessionID: input.assistantInfo.sessionID,
                    type: "tool",
                    tool: value.toolName,
                    callID: value.id,
                    state: {
                      status: "pending",
                      input: {},
                      raw: "",
                    },
                  })
                  toolcalls[value.id] = part as Message.ToolPart
                  break

                case "tool-input-delta": {
                  const match = toolcalls[value.id]
                  if (!match || match.state.status !== "pending") break
                  match.state.raw += value.delta
                  const parsed = parseToolInputPartial(match.state.raw)
                  if (parsed) match.state.input = parsed
                  if (!toolInputFlushTimers[value.id]) {
                    toolInputFlushTimers[value.id] = setTimeout(() => {
                      flushToolInputPart(value.id).catch(() => undefined)
                    }, TOOL_INPUT_FLUSH_MS)
                  }
                  break
                }

                case "tool-input-end":
                  await flushToolInputPart(value.id)
                  break

                case "tool-call": {
                  const match = toolcalls[value.toolCallId]
                  if (match) {
                    cancelToolInputFlush(value.toolCallId)
                    // Mark the call running in memory synchronously, then persist. After enqueuing tool-call, the AI
                    // SDK runToolsTransformation starts the wrapped execute without awaiting it, concurrently with this
                    // handler. If toolcalls were updated after await Session.updatePart, the first ctx.metadata call
                    // could still see the pending part and the `status === "running"` gate in runner.ts would drop
                    // it, so the UI would wait for the next progress update. Updating before the await closes that
                    // race.
                    const runningPart: Message.ToolPart = {
                      ...match,
                      tool: value.toolName,
                      state: {
                        status: "running",
                        input: value.input,
                        time: {
                          start: Date.now(),
                        },
                      },
                      metadata: value.providerMetadata,
                    }
                    toolcalls[value.toolCallId] = runningPart
                    await Session.updatePart(runningPart)

                    // Parts across steps include step-start/step-finish, so keep only tool parts; otherwise lastThree
                    // usually ends with [step-finish, step-start, tool] and the check never fires
                    const parts = await Message.parts({
                      sessionID: input.assistantInfo.sessionID,
                      messageID: input.assistantInfo.id,
                    })
                    const toolParts = parts.filter((p): p is Message.ToolPart => p.type === "tool")
                    const lastThree = toolParts.slice(-DOOM_LOOP_THRESHOLD)
                    if (
                      lastThree.length === DOOM_LOOP_THRESHOLD &&
                      lastThree.every(
                        (p) =>
                          p.tool === value.toolName &&
                          p.state.status !== "pending" &&
                          JSON.stringify(p.state.input) === JSON.stringify(value.input),
                      )
                    ) {
                      doomLoopFlagged.add(value.toolCallId)
                    }
                  }
                  break
                }
                case "tool-result": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    const baseOut = value.output.output ?? ""
                    const output = doomLoopFlagged.has(value.toolCallId) ? baseOut + DOOM_LOOP_REMINDER : baseOut
                    doomLoopFlagged.delete(value.toolCallId)
                    const persisted = persistToolResult({
                      tool: match.tool,
                      input: value.input ?? match.state.input,
                      output,
                      title: value.output.title,
                      metadata: (value.output.metadata ?? {}) as Record<string, unknown>,
                      start: match.state.time.start,
                      end: Date.now(),
                      attachments: value.output.attachments,
                    })
                    const completedPart = await Session.updatePart({
                      ...match,
                      state: persisted.state,
                    })
                    const stop =
                      value.output &&
                      typeof value.output === "object" &&
                      (value.output as { stop?: boolean }).stop === true

                    // A detached workflow_run still pushes its terminal status later (running -> completed/failed/
                    // aborted). Keep its completed part in completedToolcalls so the background run can update it via
                    // ctx.metadata and updateToolCallMetadata; otherwise the card stays stuck at its launch snapshot.
                    if (stop || match.tool === "workflow_run") {
                      completedToolcalls[value.toolCallId] = completedPart as Message.ToolPart
                    }
                    if (stop) stopTurn = true

                    if (persisted.countSuccess) successToolCount++
                    delete toolcalls[value.toolCallId]
                  }
                  break
                }

                case "tool-error": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    const rejected =
                      value.error instanceof PermissionNext.RejectedError ||
                      value.error instanceof Question.RejectedError
                    const message = value.error instanceof Error ? value.error.message : String(value.error)
                    const errorKind: Message.ToolErrorKind = rejected
                      ? "permission_rejected"
                      : /(?:timed?\s*out|timeout)/i.test(message)
                        ? "timeout"
                        : "execution"

                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "error",
                        input: value.input ?? match.state.input,
                        error: message,
                        metadata: { errorKind },
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                      },
                    })

                    if (rejected) {
                      rejectedCount++
                    }
                    delete toolcalls[value.toolCallId]
                  }
                  break
                }
                case "error":
                  throw value.error

                case "start-step":
                  snapshot ??= await Snapshot.track(input.sessionID)
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    messageID: input.assistantInfo.id,
                    sessionID: input.sessionID,
                    snapshot,
                    type: "step-start",
                  })
                  break

                case "finish-step":
                  const usage = Session.getUsage({
                    model: input.model,
                    usage: value.usage,
                    metadata: value.providerMetadata,
                  })
                  input.assistantInfo.finish = value.finishReason
                  input.assistantInfo.cost += usage.cost
                  input.assistantInfo.tokens = usage.tokens
                  // Create the finish backup and make it active, then capture this step's changed files into it;
                  // otherwise diffFull(step-start, step-finish) misses new or modified content (summary shows 0 lines)
                  const finishSnapshot = await Snapshot.track(input.sessionID)
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    reason: value.finishReason,
                    snapshot: finishSnapshot,
                    messageID: input.assistantInfo.id,
                    sessionID: input.assistantInfo.sessionID,
                    type: "step-finish",
                    tokens: usage.tokens,
                    cost: usage.cost,
                  })
                  await Session.updateInfo(input.assistantInfo)
                  if (snapshot) {
                    const patch = await Snapshot.patch(snapshot, input.sessionID)
                    if (patch.files.length) {
                      // finishSnapshot is already active: write the current workspace into it for SessionSummary and
                      // the TUI session.diff
                      if (finishSnapshot) await Snapshot.captureWorkspaceFiles(patch.files, input.sessionID)
                      await Session.updatePart({
                        id: Identifier.ascending("part"),
                        messageID: input.assistantInfo.id,
                        sessionID: input.sessionID,
                        type: "patch",
                        backupID: patch.backupID,
                        files: patch.files,
                        additions: patch.additions,
                        deletions: patch.deletions,
                      })
                    }
                    snapshot = undefined
                  }
                  SessionSummary.summarize({
                    sessionID: input.sessionID,
                    messageID: input.assistantInfo.parentID,
                  }).catch((err) => log.error("session summary failed", { error: err }))
                  if (await SessionCompaction.isOverflow({ tokens: usage.tokens, model: input.model })) {
                    needsCompaction = true
                  }
                  break

                case "text-start":
                  currentText = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantInfo.id,
                    sessionID: input.assistantInfo.sessionID,
                    type: "text",
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  break

                case "text-delta":
                  if (currentText) {
                    currentText.text += value.text
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    if (currentText.text)
                      await Session.updatePart({
                        part: currentText,
                        delta: value.text,
                      })
                  }
                  break

                case "text-end":
                  if (currentText) {
                    currentText.text = currentText.text.trimEnd()
                    const textOutput = await Plugin.trigger(
                      "experimental.text.complete",
                      {
                        sessionID: input.sessionID,
                        messageID: input.assistantInfo.id,
                        partID: currentText.id,
                      },
                      { text: currentText.text },
                    )
                    currentText.text = textOutput.text
                    currentText.time = {
                      start: Date.now(),
                      end: Date.now(),
                    }
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    await Session.updatePart(currentText)
                  }
                  currentText = undefined
                  break

                case "finish":
                  break

                default:
                  log.info("unhandled", {
                    ...value,
                  })
                  continue
              }
              if (needsCompaction) break
            }
          } catch (e) {
            if ((await handleStreamError(e)) === "retry") continue
          }
          if (snapshot) {
            const patch = await Snapshot.patch(snapshot, input.sessionID)
            if (patch.files.length) {
              await Session.updatePart({
                id: Identifier.ascending("part"),
                messageID: input.assistantInfo.id,
                sessionID: input.sessionID,
                type: "patch",
                backupID: patch.backupID,
                files: patch.files,
                additions: patch.additions,
                deletions: patch.deletions,
              })
            }
            snapshot = undefined
          }
          cancelAllToolInputFlush()
          const p = await Message.parts({
            sessionID: input.assistantInfo.sessionID,
            messageID: input.assistantInfo.id,
          })
          // Tell a user interrupt from a real failure: aborts say "aborted", real failures (such as model capacity
          // errors) say "failed" with the reason. Otherwise the model may read a capacity error as an abort and give
          // up on a workflow that actually detached successfully.
          const failedMessage = (input.assistantInfo.error?.data as { message?: unknown } | undefined)?.message
          const toolError = input.abort.aborted
            ? "Tool execution aborted"
            : `Tool execution failed${typeof failedMessage === "string" && failedMessage ? `: ${failedMessage}` : ""}`
          for (const part of p) {
            if (part.type === "tool" && part.state.status !== "completed" && part.state.status !== "error") {
              // workflow_run detaches before its tool-result returns. If the turn ends for another reason, do not mark
              // the running workflow as error, or the chat would show "Tool execution failed" while it keeps running.
              if (part.tool === "workflow_run") continue
              await Session.updatePart({
                ...part,
                state: {
                  ...part.state,
                  status: "error",
                  error: toolError,
                  time: {
                    start: Date.now(),
                    end: Date.now(),
                  },
                },
              })
            }
            // Without reasoning-end from the provider (aborted or failed mid-reasoning, or a split stream that never
            // flushed), a reasoning part never gets time.end and clients fall back to Date.now(). Backfill a bounded
            // end once the stream is over.
            if (needsReasoningEndBackfill(part)) {
              await Session.updatePart({
                ...part,
                time: {
                  ...part.time,
                  end: Date.now(),
                },
              })
            }
          }
          await finalizeAssistantText({ sessionID: input.sessionID, messageID: input.assistantInfo.id })

          input.assistantInfo.time.completed = Date.now()
          await Session.updateInfo(input.assistantInfo)
          if (stopTurn) return "stop"
          if (needsCompaction) return "compact"
          if (shouldBreak && rejectedCount > 0 && successToolCount === 0) return "stop"
          if (input.assistantInfo.error) return "stop"
          return "continue"
        }
      },
    }
    return result
  }
}
