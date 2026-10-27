import { BusEvent } from "../bus/bus-event"
import { Bus } from "../bus"
import { Session } from "."
import { Identifier } from "@merakcode/util/id"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { Message } from "./message"
import z from "zod"
import { Token } from "../util/token"
import { Log } from "@merakcode/log/logger"
import { SessionProcessor } from "./processor"
import { fn } from "../util/fn"
import { Agent } from "../agent/agent"
import { Plugin } from "../plugin"
import { Config } from "../config/config"
import { ProviderTransform } from "../provider/transform"
import { PermissionMode } from "../permission/mode"
import { SessionContextLayer } from "./context-layer"
import { SessionContextBudget } from "./context-budget"
import { SessionToolResult } from "./tool-result"
import { MemoryRecall } from "../memory/recall"
import { truncateSections } from "../session-memory/template"
import { SessionStatus } from "./status"
import { SessionCompactionRestore } from "./compaction-restore"
import { scanActivatedTools } from "../tool/tool-search"
import { Text } from "../util/text"

export namespace SessionCompaction {
  const log = Log.create({ service: "session.compaction" })

  export const Event = {
    Compacted: BusEvent.define(
      "session.compacted",
      z.object({
        sessionID: z.string(),
      }),
    ),
  }

  const COMPACTION_BUFFER = 20_000

  // Auto-compaction circuit breaker: after N consecutive summary failures, switch to fallbackPrune (no LLM cost) plus
  // the blocking limit instead of forking summary agents that keep failing and burning tokens. Counts are per
  // sessionID and live in process memory only.
  const FAILURE_THRESHOLD_DEFAULT = 3
  const failureCount = new Map<string, { count: number; lastAt: number }>()

  /** Reads the breaker threshold from config (default 3); falls back to the default outside an Instance context. */
  async function failureThreshold() {
    try {
      const config = await Config.get()
      return config.compaction?.failureThreshold ?? FAILURE_THRESHOLD_DEFAULT
    } catch {
      return FAILURE_THRESHOLD_DEFAULT
    }
  }

  /** Records an auto-compaction result: success resets the count, failure increments it. */
  export function recordCompactionResult(sessionID: string, ok: boolean) {
    const entry = failureCount.get(sessionID) ?? { count: 0, lastAt: 0 }
    entry.count = ok ? 0 : entry.count + 1
    entry.lastAt = Date.now()
    failureCount.set(sessionID, entry)
  }

  /** Whether consecutive failures have reached the threshold. */
  export async function isCompactionTripped(sessionID: string) {
    return (failureCount.get(sessionID)?.count ?? 0) >= (await failureThreshold())
  }

  /** Resets the breaker after a successful manual /compact or summary. */
  export function resetCompactionFailures(sessionID: string) {
    failureCount.delete(sessionID)
  }

  export async function capacity(model: Provider.Model) {
    const config = await Config.get()
    const maxOutput = ProviderTransform.maxOutputTokens(model)
    const reserved = config.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, maxOutput)
    const usable = model.limit.input ? model.limit.input - reserved : model.limit.context - maxOutput

    return {
      reserved,
      usable: Math.max(0, usable),
      maxOutput,
    }
  }

  // isOverflow() triggers some tokens before usable is full. This covers (1) natural growth of the next request over
  // the current count (tool definitions, injected context) and (2) small differences between provider billing and
  // local estimates. The buffer is a fraction of usable: small models get a smaller buffer (with a floor so it still
  // matters), large models a larger one (with a cap so we don't compact too early).
  // It only affects when compaction starts; capacity()/usable keep their meaning, so the Free figure in
  // context-report.ts and the tripBlockingLimit() message still use the raw usable value.
  const PREEMPT_BUFFER_RATIO = 0.05
  const PREEMPT_BUFFER_MIN = 2_000 // Same order as PREFLIGHT_SAFETY_MARGIN in context-view.ts.
  const PREEMPT_BUFFER_MAX = 6_000 // 3x PREFLIGHT_SAFETY_MARGIN.

  /** Preemptive buffer proportional to usable, clamped to [PREEMPT_BUFFER_MIN, PREEMPT_BUFFER_MAX]. */
  export function preemptBuffer(usable: number): number {
    return Math.min(PREEMPT_BUFFER_MAX, Math.max(PREEMPT_BUFFER_MIN, Math.round(usable * PREEMPT_BUFFER_RATIO)))
  }

  /** Threshold used by isOverflow(): usable minus the preemptive buffer, clamped to 0. */
  export function overflowThreshold(usable: number): number {
    return Math.max(0, usable - preemptBuffer(usable))
  }

  export async function isOverflow(input: { tokens: Message.AssistantInfo["tokens"]; model: Provider.Model }) {
    const config = await Config.get()
    if (config.compaction?.auto === false) return false
    const context = input.model.limit.context
    if (context === 0) return false

    const count =
      input.tokens.total ||
      input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write

    const cap = await capacity(input.model)
    return count >= overflowThreshold(cap.usable)
  }

  export const PRUNE_MINIMUM = 20_000
  export const PRUNE_PROTECT = 40_000

  // Aggressive thresholds used once the breaker trips: protect less and prune more old tool output.
  const FALLBACK_PRUNE_PROTECT = 8_000
  const FALLBACK_PRUNE_MINIMUM = 4_000

  // goes backwards through parts until there are `protect` tokens worth of tool
  // calls. then erases output of previous tool calls. idea is to throw away old
  // tool calls that are no longer relevant.
  export async function prune(input: { sessionID: string; protect?: number; minimum?: number }) {
    const config = await Config.get()
    if (config.compaction?.prune === false) return
    const protect = input.protect ?? PRUNE_PROTECT
    const minimum = input.minimum ?? PRUNE_MINIMUM
    log.info("pruning", { protect, minimum })
    const msgs = await Session.messages({ sessionID: input.sessionID })
    let total = 0
    let pruned = 0
    const toPrune = []
    let turns = 0

    loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
      const fullMsg = msgs[msgIndex]
      if (fullMsg.info.role === "user") turns++
      // Share RECENT_TURNS with the context budget so both protection windows stay in sync.
      if (turns < SessionContextBudget.RECENT_TURNS) continue
      if (fullMsg.info.role === "assistant" && !Message.isExternal(fullMsg.info) && fullMsg.info.summary) break loop
      for (let partIndex = fullMsg.parts.length - 1; partIndex >= 0; partIndex--) {
        const part = fullMsg.parts[partIndex]
        if (part.type === "tool")
          if (part.state.status === "completed") {
            if (SessionToolResult.isProtected(part.tool)) continue

            if (part.state.time.compacted) break loop
            const estimate = Token.estimate(part.state.output)
            total += estimate
            if (total > protect) {
              pruned += estimate
              toPrune.push(part)
            }
          }
      }
    }
    log.info("found", { pruned, total })
    if (pruned > minimum) {
      for (const part of toPrune) {
        if (part.state.status === "completed") {
          part.state.time.compacted = Date.now()
          await Session.updatePart(part)
        }
      }
      log.info("pruned", { count: toPrune.length })
    }
  }

  /**
   * Fallback once the breaker trips: prune with aggressive thresholds to free tool output space without an LLM call.
   * Goes through prune() so the config.compaction.prune switch still applies.
   */
  export async function fallbackPrune(input: { sessionID: string }) {
    await prune({
      sessionID: input.sessionID,
      protect: FALLBACK_PRUNE_PROTECT,
      minimum: FALLBACK_PRUNE_MINIMUM,
    })
  }

  /**
   * Blocking limit: when the breaker has tripped and fallbackPrune still leaves the context over capacity, publish an
   * error and set the session idle. Controlled by config.compaction.blockingLimit (on by default).
   */
  export async function tripBlockingLimit(input: { sessionID: string; tokens: number; model: Provider.Model }) {
    const config = await Config.get()
    if (config.compaction?.blockingLimit === false) return
    const cap = await capacity(input.model)
    const error = new Message.CompactionBlockedError({
      message: await Text.pick({
        zh: "上下文已超出模型容量，且自动压缩连续失败。请手动执行 /compact 压缩历史，或开启新会话后继续。",
        en: "The context exceeds the model's capacity and automatic compaction failed repeatedly. Run /compact to compact the history manually, or continue in a new session.",
      }),
      tokens: input.tokens,
      usable: cap.usable,
    }).toObject()
    Bus.publish(Session.Event.Error, { sessionID: input.sessionID, error })
    SessionStatus.set(input.sessionID, { type: "idle" })
  }

  /**
   * After auto compaction, restores attachments and adds a strong continuation instruction.
   * Shared by the SessionMemory summary path and the LLM summary path.
   */
  async function restoreAfterCompaction(
    input: { sessionID: string; messages: Message.FullMsg[]; auto: boolean },
    userInfo: Message.UserInfo,
    continuationPermissionMode: PermissionMode.Value | undefined,
    model: Provider.Model,
  ) {
    if (!input.auto) return
    const continueMsg = await Session.updateInfo({
      id: Identifier.ascending("message"),
      role: "user",
      sessionID: input.sessionID,
      time: { created: Date.now() },
      agent: userInfo.agent,
      permissionMode: continuationPermissionMode,
      model: userInfo.model,
    })
    // Write the restored attachment parts first so their smaller ids sort before the continuation instruction in
    // toModelMessages. Re-injecting todos, plan, recent files and skills lost to compaction gives the model a clear
    // signal that work remains. Each category handles its own errors: failures are logged and never block.
    const restored = await SessionCompactionRestore.attachments({
      sessionID: input.sessionID,
      messageID: continueMsg.id,
      messages: input.messages,
      model,
      agent: userInfo.agent,
    })
    for (const part of restored) {
      await Session.updatePart(part)
    }
    // The continuation instruction gets a larger id so it sorts after the attachments.
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: continueMsg.id,
      sessionID: input.sessionID,
      type: "text",
      synthetic: true,
      text: [
        "You were just auto-compacted due to context limit. Continue completing the unfinished task directly based on the summary above.",
        '- Do not stop to ask the user, do not restate the summary, and do not preface with phrases like "I\'ll continue".',
        "- Pick up the work as if the break never happened; if there are unfinished todos or a plan, immediately advance the next step.",
        "- Stop only when the task is genuinely fully complete, or when you truly need key information from the user to proceed.",
      ].join("\n"),
      time: { start: Date.now(), end: Date.now() },
    })
  }

  /** Redacts the summary, resets the breaker and publishes the compacted event. */
  async function finalizeCompaction(sessionID: string, assistantInfo: Message.AssistantInfo) {
    await redactCompactionSummary({ sessionID, messageID: assistantInfo.id })
    resetCompactionFailures(sessionID)
    Bus.publish(Event.Compacted, { sessionID })
  }

  /** memory.session_memory_compact switch (on by default; false falls back to the LLM summary). */
  async function sessionMemoryCompactEnabled(): Promise<boolean> {
    if (!Instance.has()) return false
    return (await Config.get()).memory?.session_memory_compact !== false
  }

  /**
   * Tries to use the SessionMemory notes as the compaction summary, which costs no LLM call.
   * Returns the formatted summary, or undefined when disabled, empty or failed so the caller falls back to the LLM.
   * SessionMemory is imported dynamically to avoid the session -> compaction -> SessionMemory -> session cycle.
   */
  async function trySessionMemorySummary(sessionID: string): Promise<string | undefined> {
    try {
      const { SessionMemory } = await import("../session-memory/session-memory")
      if (!(await SessionMemory.enabled())) return undefined
      if (!(await sessionMemoryCompactEnabled())) return undefined
      await SessionMemory.waitForExtraction(sessionID) // Wait for in-flight extraction so the notes are not stale.
      const content = await SessionMemory.content(sessionID)
      if (!content) return undefined // Missing file or empty template.
      const truncated = truncateSections(content, 2000) // Keep large sections from filling the summary budget.
      return [
        "This session is being continued from a previous conversation that ran out of context.",
        "The session notes below cover the earlier portion of the conversation.",
        "",
        truncated,
        "",
        "Continue the conversation from where it left off. Resume directly - do not acknowledge the notes.",
      ].join("\n")
    } catch (error) {
      log.warn("session memory compaction failed, falling back to LLM summary", { error, sessionID })
      return undefined
    }
  }

  export async function process(input: {
    parentID: string
    messages: Message.FullMsg[]
    sessionID: string
    abort: AbortSignal
    auto: boolean
  }) {
    const parent = input.messages.findLast((m) => m.info.id === input.parentID)
    if (!parent || parent.info.role !== "user") throw new Error("Compaction parent user message not found")
    const userInfo = parent.info as Message.UserInfo
    const part = parent.parts.find((p): p is Message.CompactionPart => p.type === "compaction")
    const continuationPermissionMode = part?.permissionMode ?? userInfo.permissionMode

    // Persist the activated deferred tools on the compaction part. After compaction, filterCompacted drops earlier
    // messages (including tool_search calls), so scanActivatedTools reads them back from the boundary; otherwise
    // activated tools would revert to deferred. input.messages is the full pre-compaction history.
    const preCompactActivated = scanActivatedTools(input.messages)
    if (part && preCompactActivated.size > 0) {
      await Session.updatePart({ ...part, preCompactActivatedTools: [...preCompactActivated] })
    }

    const agent = await Agent.get("compaction")
    const model = agent.model
      ? await Provider.getModel(agent.model.providerID, agent.model.modelID)
      : await Provider.getModel(userInfo.model.providerID, userInfo.model.modelID)
    const assistantInfo = (await Session.updateInfo({
      id: Identifier.ascending("message"),
      role: "assistant",
      parentID: input.parentID,
      sessionID: input.sessionID,
      mode: "compaction",
      agent: "compaction",
      variant: userInfo.variant,
      summary: true,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      cost: 0,
      tokens: {
        output: 0,
        input: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: model.id,
      providerID: model.providerID,
      time: {
        created: Date.now(),
      },
    })) as Message.AssistantInfo
    // Try the SessionMemory summary first; it skips the LLM summary call.
    const smSummary = await trySessionMemorySummary(input.sessionID)
    if (smSummary) {
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: assistantInfo.id,
        sessionID: input.sessionID,
        type: "text",
        text: smSummary,
        time: { start: Date.now(), end: Date.now() },
      })
      assistantInfo.finish = "stop"
      await Session.updateInfo(assistantInfo)
      await restoreAfterCompaction(input, userInfo, continuationPermissionMode, model)
      await finalizeCompaction(input.sessionID, assistantInfo)
      return "continue"
    }

    const processor = SessionProcessor.create({
      assistantInfo,
      sessionID: input.sessionID,
      model,
      abort: input.abort,
    })
    // Allow plugins to inject context or replace compaction prompt
    const compacting = await Plugin.trigger(
      "experimental.session.compacting",
      { sessionID: input.sessionID },
      { context: [], prompt: undefined },
    )
    const layeredPrompt = `The conversation may be layered: a <compaction-base> block is a previous summary, and the messages after it are newer delta context.
Merge the previous summary with the newer delta context into one updated continuation prompt.
Prefer newer messages when they conflict with the previous summary.`
    const defaultPrompt = `Provide a detailed prompt for continuing our conversation above.
Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next.
The summary that you construct will be used so that another agent can read it and continue the work.

When constructing the summary, try to stick to this template:
---
## Goal

[What goal(s) is the user trying to accomplish?]

## Instructions

- [What important instructions did the user give you that are relevant]
- [If there is a plan or spec, include information about it so next agent can continue using it]

## Discoveries

[What notable things were learned during this conversation that would be useful for the next agent to know when continuing the work]

## Accomplished

[What work has been completed, what work is still in progress, and what work is left?]

## Current Work

[What was being worked on right before compaction, precise to file names, functions, and code snippets. Do not be vague — the next agent must pick this up seamlessly]

## Next Step

[The next step directly related to Current Work. If there was an unfinished action before compaction, quote verbatim from the recent conversation what you were doing and where you left off, to avoid task interpretation drift]

## Relevant files / directories

[Construct a structured list of relevant files that have been read, edited, or created that pertain to the task at hand. If all the files in a directory are relevant, include the path to the directory.]
---`

    const promptText = compacting.prompt
      ? [layeredPrompt, compacting.prompt].join("\n\n")
      : [layeredPrompt, defaultPrompt, ...compacting.context].join("\n\n")
    // The compaction request itself can overflow: the summary model may have a smaller context window, and whether
    // input.messages was trimmed depends on the caller. Always apply the same budget trimming as normal turns so the
    // input is bounded. A summary call has no recursive compaction fallback (scheduleCompaction in processor.ts returns
    // false for summary messages), so an overflow just fails, and only degrades after reaching the breaker threshold,
    // wasting real LLM calls. Idempotent: already trimmed entries are skipped.
    SessionContextBudget.applyToProjection({ messages: input.messages })
    const sanitized = stripMemoryContext(input.messages)
    // Final filter before sampling the summary. The summary model has no system prompt and no tool path gate, so a
    // sensitive read that was legitimately allowed earlier would be baked into the permanent <compaction-base>
    // summary and escape the per-access intent check. redactCompactionSummary covers the output side.
    //
    // The decision belongs to plugins; the engine has no built-in sensitive path filter, so without a plugin the
    // messages pass through unchanged. Same contract as experimental.chat.messages.transform in context-view.ts:
    // plugins mutate output.messages in place (add/remove/replace elements) rather than replacing the array.
    await Plugin.trigger(
      "experimental.compaction.messages.transform",
      { sessionID: input.sessionID },
      { messages: sanitized },
    )
    const result = await processor.process({
      user: userInfo,
      agent,
      abort: input.abort,
      sessionID: input.sessionID,
      tools: {},
      system: [],
      messages: [
        // sanitized has already gone through experimental.compaction.messages.transform above;
        // redactCompactionSummary scans the output side.
        ...(await SessionContextLayer.toModelMessages({
          messages: sanitized,
          model,
          excludeMessageID: input.parentID,
        })),
        {
          role: "user",
          content: [
            {
              type: "text",
              text: promptText,
            },
          ],
        },
      ],
      model,
    })

    if (result === "continue" && input.auto) {
      await restoreAfterCompaction(input, userInfo, continuationPermissionMode, model)
    }
    if (processor.message.error) {
      // Only auto compaction failures count toward the breaker; a failed manual /compact does not.
      if (input.auto) recordCompactionResult(input.sessionID, false)
      return "stop"
    }
    await finalizeCompaction(input.sessionID, assistantInfo)
    return "continue"
  }

  /** @internal Exported for focused regression tests. */
  export async function redactCompactionSummary(input: { sessionID: string; messageID: string }) {
    const messages = await Session.messages({ sessionID: input.sessionID })
    const target = messages.find((m) => m.info.id === input.messageID)
    if (!target) return
    for (const part of target.parts) {
      if (part.type !== "text") continue
      // Output-side redaction of the summary. The decision belongs entirely to plugins: without one, the summary passes
      // through unchanged.
      const { Plugin } = await import("../plugin")
      const { summary } = await Plugin.trigger(
        "experimental.compaction.summary.transform",
        { sessionID: input.sessionID },
        { summary: part.text },
      )
      if (summary === part.text) continue
      await Session.updatePart({ ...part, text: summary })
    }
  }

  /** @internal Exported for focused regression tests. */
  export function stripMemoryContext(messages: Message.FullMsg[]) {
    return messages.map((message) => ({
      ...message,
      parts: message.parts.filter(
        (part) => !(part.type === "text" && part.metadata?.memory?.kind === MemoryRecall.METADATA_KIND),
      ),
    }))
  }

  export const create = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      agent: z.string(),
      model: z.object({
        providerID: z.string(),
        modelID: z.string(),
      }),
      permissionMode: PermissionMode.Schema.optional(),
      auto: z.boolean(),
    }),
    async (input) => {
      const userInfo = await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: {
          created: Date.now(),
        },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: userInfo.id,
        sessionID: userInfo.sessionID,
        type: "compaction",
        auto: input.auto,
        permissionMode: input.permissionMode,
      })
    },
  )
}
