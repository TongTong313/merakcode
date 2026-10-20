import path from "path"
import fs from "fs/promises"
import { Log } from "@merakcode/log/logger"
import { Bus } from "../bus"
import { Config } from "../config/config"
import { NotifyEvent } from "../notify/event"
import { Instance } from "../project/instance"
import { Session } from "../session"
import { Message } from "../session/message"
import { Storage } from "../storage/storage"
import { MemoryAccess } from "./access"
import { MemoryPath } from "./path"
import { MemoryScan } from "./scan"
import { localDate, pickMemoryModel, resolveExtractPolicy } from "./util"
import { Filesystem } from "@merakcode/util/filesystem"
import { Text } from "../util/text"

export namespace MemoryExtract {
  const log = Log.create({ service: "memory.extract" })
  const EXTRACTOR_AGENT = "memory-extractor"
  const EXTRACTOR_TITLE = "memory extraction"
  const NO_UPDATES = "No memory updates."
  const MEMORY_SIGNAL =
    /\b(remember|forget|memory|memories|preference|preferences|prefer|feedback|next time|from now on|always|never|avoid|do not|don't)\b|记住|忘记|记忆|偏好|反馈|以后|下次|不要|别再|避免|始终|永远|更喜欢|纠正/iu

  type Input = {
    session: Session.Info
    assistant: Message.AssistantInfo
    model: Message.UserInfo["model"]
  }

  type Entry = {
    inFlight?: Promise<void>
    pending?: Input
    lastAssistantID?: string
    /** Advances only when a run succeeds; after a failure the same turns are reconsidered next time */
    lastSuccessfulAssistantID?: string
    /** Counts turns; extraction runs once the count reaches extract_interval */
    turnsSinceLastExtraction?: number
  }

  const state = Instance.state(() => new Map<string, Entry>())

  export function schedule(input: Input) {
    if (input.session.parentID) return
    if (input.assistant.error) return

    const sessions = state()
    const entry = sessions.get(input.session.id) ?? {}
    sessions.set(input.session.id, entry)

    // Skip assistants already processed successfully; failed runs do not advance the cursor, so they are retried
    if (entry.lastSuccessfulAssistantID === input.assistant.id) return
    if (entry.pending?.assistant.id === input.assistant.id) return

    // run checks the count against the threshold
    entry.turnsSinceLastExtraction = (entry.turnsSinceLastExtraction ?? 0) + 1

    if (entry.inFlight) {
      entry.pending = input
      return
    }

    start(entry, input)
  }

  export function permissions() {
    return MemoryAccess.extractorRules()
  }

  /** Counts user and assistant messages: all of them without a cursor, otherwise those after the cursor */
  export function visibleCountSince(messages: { id: string; role: string }[], cursor?: string) {
    const visible = (role: string) => role === "user" || role === "assistant"
    const all = () => messages.filter((message) => visible(message.role)).length
    if (!cursor) return all()
    let found = false
    let n = 0
    for (const message of messages) {
      if (!found) {
        if (message.id === cursor) found = true
        continue
      }
      if (visible(message.role)) n++
    }
    if (!found) return all()
    return n
  }

  export async function prompt(input?: { newMessageCount: number }) {
    const memoryDir = MemoryPath.directory()
    const index = await Filesystem.readText(MemoryPath.entrypoint()).catch(() => "")
    const manifest = await MemoryScan.files(memoryDir)
    const n = input?.newMessageCount
    const scoped = typeof n === "number"

    return [
      "# Automatic memory extraction",
      "",
      scoped
        ? "You are MerakCode's post-turn memory extraction pass."
        : "You are MerakCode's post-turn memory extraction pass. Review the conversation above and decide whether any durable, future-useful memory should be saved.",
      ...(scoped
        ? ["", `Analyze the most recent ~${n} messages above and use them to update your persistent memory systems.`]
        : []),
      "",
      `Today is ${localDate()}. Convert relative dates from the conversation to absolute dates before saving project memories.`,
      "",
      `Memory directory: \`${memoryDir}\``,
      `Memory index: \`${MemoryPath.entrypoint()}\``,
      "",
      "## Turn budget",
      "",
      "You have a limited turn budget. Edit requires a prior Read of the same file, so the efficient strategy is: turn 1 - issue all Read calls in parallel for every file you might update; turn 2 - issue all Write/Edit calls in parallel. Do not interleave reads and writes across multiple turns.",
      scoped
        ? `You MUST only use content from the last ~${n} messages to update your persistent memories. Do not waste turns investigating or verifying - no grepping source files, no reading code to confirm a pattern exists.`
        : "You MUST only use content from the conversation above. Do not waste turns investigating or verifying - no grepping source files, no reading code to confirm a pattern exists.",
      "",
      "## What to do",
      "",
      "- Save only durable information that will help future conversations: user profile/preferences, feedback about how to work, non-derivable project context, or references to external systems.",
      "- Do not save code structure, file paths, implementation details, test results, current task progress, or anything already documented in AGENTS.md; those are derivable from the repo or current conversation.",
      "- Reference memories require a concrete external locator: URL, external system name plus project/key/channel, dashboard id, ticket tracker project, or similar. Never save local docs, plans, architecture guides, README content, AGENTS.md content, repo file paths, implementation notes, task checklists, merge summaries, test results, or copied document content as `reference` memory.",
      "- If the user explicitly asked MerakCode to remember or forget something, perform that memory update.",
      "- If there is nothing worth saving, do not call tools; reply exactly: " + NO_UPDATES,
      "- Do not mention this extraction pass to the user.",
      "- Do not create daily logs, dreams, rollups, summaries, or auto-dream artifacts.",
      "",
      "## How to write",
      "",
      `- First check \`${MemoryPath.ENTRYPOINT_NAME}\` and the relevant type directory to avoid duplicates.`,
      "- Write or update one topic memory file under exactly one type subdirectory: `user/`, `feedback/`, `project/`, or `reference/`.",
      `- Keep \`${MemoryPath.ENTRYPOINT_NAME}\` as a concise one-line-per-memory index. Never write memory body content directly into it.`,
      "- Use the existing memory frontmatter format and keep `name`, `description`, and `type` accurate.",
      "",
      "## Existing memory index",
      "",
      index.trim() ? index.trim() : `(empty ${MemoryPath.ENTRYPOINT_NAME})`,
      "",
      "## Existing memory files",
      "",
      manifest.length > 0
        ? manifest
            .map((item) =>
              [
                `- ${item.filename.replaceAll(path.sep, "/")}`,
                item.name ? `name: ${item.name}` : undefined,
                item.description ? `description: ${item.description}` : undefined,
                item.type ? `type: ${item.type}` : undefined,
              ]
                .filter(Boolean)
                .join(" | "),
            )
            .join("\n")
        : "(none)",
    ].join("\n")
  }

  export function hasMemoryWriteParts(parts: Message.Part[]) {
    return parts.some((part) => {
      if (part.type !== "tool") return false
      if (part.state.status !== "completed") return false
      return toolMemoryPaths(part).some(MemoryAccess.isWritablePath)
    })
  }

  function cursorKey(sessionID: string) {
    return ["memory_extract", sessionID]
  }

  /** Persists the success cursor per session so that counting and write checks resume after a restart. */
  export async function writeCursor(sessionID: string, lastSuccessfulAssistantID: string) {
    await Storage.write(cursorKey(sessionID), { lastSuccessfulAssistantID })
  }

  export async function readCursor(sessionID: string) {
    const stored = await Storage.read<{ lastSuccessfulAssistantID?: string }>(cursorKey(sessionID)).catch(
      () => undefined,
    )
    return stored?.lastSuccessfulAssistantID
  }

  export async function removeCursor(sessionID: string) {
    await Storage.remove(cursorKey(sessionID))
  }

  /**
   * Whether a completed memory write follows the cursor. Without a cursor, scans from the start; returns false when
   * the cursor is not found.
   */
  export function hasMemoryWritesSince(messages: { id: string; parts: Message.Part[] }[], cursor?: string) {
    let found = cursor === undefined
    for (const message of messages) {
      if (!found) {
        if (message.id === cursor) found = true
        continue
      }
      if (hasMemoryWriteParts(message.parts)) return true
    }
    return false
  }

  function start(entry: Entry, input: Input) {
    entry.inFlight = run(input)
      .then(async (ok) => {
        // Only success (including "nothing to extract") advances the cursor and resets the throttle
        if (ok) {
          entry.lastSuccessfulAssistantID = input.assistant.id
          entry.turnsSinceLastExtraction = 0
          await writeCursor(input.session.id, input.assistant.id).catch((error) => {
            log.warn("memory extract cursor persist failed", { error, sessionID: input.session.id })
          })
        }
      })
      .catch((error) => {
        log.warn("memory extraction failed", { error, sessionID: input.session.id, assistantID: input.assistant.id })
      })
      .finally(() => {
        entry.lastAssistantID = input.assistant.id
        entry.inFlight = undefined
        // Trailing extraction: run the request stashed while in flight so it is not lost
        const pending = entry.pending
        entry.pending = undefined
        if (pending && pending.assistant.id !== entry.lastAssistantID) start(entry, pending)
      })
  }

  async function run(input: Input): Promise<boolean> {
    const policy = await autoExtractPolicy()
    if (policy === "off") return true

    // Below extract_interval: skip, returning false so the count keeps accumulating
    const interval = await extractInterval()
    const entry = state().get(input.session.id)
    if (entry && (entry.turnsSinceLastExtraction ?? 0) < interval) return false

    const session = await Session.get(input.session.id).catch(() => undefined)
    if (!session || session.parentID) return true

    // Load the cursor from disk so a restart does not look like a session that was never extracted
    if (entry && !entry.lastSuccessfulAssistantID) {
      const stored = await readCursor(session.id)
      if (stored) entry.lastSuccessfulAssistantID = stored
    }

    // Both N and the memory-write check use the compacted window the fork sees, not the full history on disk and not
    // just this turn
    const window = await Message.filterCompacted(Message.stream(session.id))
    const cursor = entry?.lastSuccessfulAssistantID
    const mapped = window.map((item) => ({ id: item.info.id, role: item.info.role, parts: item.parts }))
    if (hasMemoryWritesSince(mapped, cursor)) {
      log.info("skipping extractor because assistant already wrote memory", {
        sessionID: session.id,
        assistantID: input.assistant.id,
      })
      return true
    }
    const parts = window.find((item) => item.info.id === input.assistant.id)?.parts ?? []
    if (policy === "signals" && !(await hasMemorySignal(input, parts))) {
      log.info("skipping extractor because no memory signal was detected", {
        sessionID: session.id,
        assistantID: input.assistant.id,
      })
      return true
    }

    // Record the index mtime before forking to tell whether extraction actually wrote memory
    const statBefore = await fs.stat(MemoryPath.entrypoint()).catch(() => undefined)
    const mtimeBefore = statBefore?.mtimeMs ?? 0

    const child = await Session.forkAsChild({
      sessionID: session.id,
      parentID: session.id,
      title: EXTRACTOR_TITLE,
      permission: permissions(),
    })
    const newMessageCount = visibleCountSince(mapped, cursor)
    const { SessionRunner } = await import("../session/runner")
    const result = await SessionRunner.promptGenerated({
      sessionID: child.id,
      agent: EXTRACTOR_AGENT,
      model: await pickMemoryModel(input.model),
      permissionMode: "ask",
      maxTurns: 5,
      parts: [
        {
          type: "text",
          text: await prompt({ newMessageCount }),
          synthetic: true,
        },
      ],
    })
    if (result.info.role !== "assistant" || result.info.error || result.info.finish !== "stop") {
      log.warn("memory extraction did not complete successfully", {
        sessionID: session.id,
        childID: child.id,
        error: result.info.role === "assistant" ? result.info.error?.name : "missing assistant",
        finish: result.info.role === "assistant" ? result.info.finish : undefined,
      })
      return false
    }
    // Notify the TUI only when the index mtime advanced, so a "nothing to extract" run does not show a toast
    const statAfter = await fs.stat(MemoryPath.entrypoint()).catch(() => undefined)
    const mtimeAfter = statAfter?.mtimeMs ?? 0
    if (mtimeAfter > mtimeBefore) {
      // Include the location so the user can find and inspect the memory files
      const lang = await Text.lang()
      await Bus.publish(NotifyEvent.ToastShow, {
        title: Text.format({ zh: "记忆提取", en: "Memory extraction" }, lang),
        message: Text.format(
          {
            zh: "已从本轮对话提取并保存记忆。\n存储位置：{dir}（索引 {index}）",
            en: "Saved memories extracted from this turn.\nLocation: {dir} (index {index})",
          },
          lang,
          { dir: MemoryPath.directory(), index: MemoryPath.ENTRYPOINT_NAME },
        ),
        variant: "success",
        duration: 8_000,
      }).catch(() => undefined)
    }
    return true
  }

  function toolMemoryPaths(part: Message.ToolPart) {
    const input = part.state.input
    if (!input || typeof input !== "object") return []

    if (part.tool === "write" || part.tool === "edit" || part.tool === "multi_edit") {
      return [resolvePath((input as { filePath?: unknown }).filePath)]
    }

    return []
  }

  function resolvePath(input: unknown) {
    if (typeof input !== "string" || input.length === 0) return ""
    return path.isAbsolute(input) ? input : path.resolve(Instance.directory, input)
  }

  async function autoExtractPolicy(): Promise<"off" | "signals" | "always"> {
    const value = (await Config.get()).memory?.auto_extract
    // Unset and true both mean "signals"; only an explicit false turns extraction off
    return resolveExtractPolicy(value)
  }

  /** Extract once every N turns (default 1) */
  async function extractInterval(): Promise<number> {
    const value = (await Config.get()).memory?.extract_interval
    return typeof value === "number" && value > 0 ? value : 1
  }

  /**
   * Waits for in-flight extractions in all sessions. Called before the process exits so forked child sessions are
   * not killed midway. Best effort: gives up after the timeout.
   */
  export async function drain(timeoutMs = 5_000): Promise<void> {
    const sessions = state()
    const inflight: Promise<void>[] = []
    for (const entry of sessions.values()) {
      if (entry.inFlight) inflight.push(entry.inFlight.catch(() => undefined))
    }
    if (inflight.length === 0) return
    await Promise.race([Promise.all(inflight), new Promise((resolve) => setTimeout(resolve, timeoutMs))])
  }

  async function hasMemorySignal(input: Input, assistantParts: Message.Part[]) {
    const text = [...textParts(assistantParts)]
    const userID = input.assistant.parentID
    const user = userID
      ? await Message.get({ sessionID: input.session.id, messageID: userID }).catch(() => undefined)
      : undefined
    if (user) text.push(...textParts(user.parts))
    return MEMORY_SIGNAL.test(text.join("\n"))
  }

  function textParts(parts: Message.Part[]) {
    return parts.filter((part): part is Message.TextPart => part.type === "text").map((part) => part.text)
  }
}
