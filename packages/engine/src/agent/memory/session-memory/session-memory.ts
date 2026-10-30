import path from "path"
import { mkdir, writeFile } from "fs/promises"
import { Log } from "@merakcode/log/logger"
import { Config } from "@merakcode/engine/agent/settings/index"
import { Instance } from "../../../infra/project/instance"
import { Session } from "../../session"
import type { Message } from "../../session/message"
import { PermissionNext } from "../../permission/next"
import { pickMemoryModel } from "../util"
import { SessionMemoryPath } from "./path"
import { SESSION_MEMORY_TEMPLATE, isEmptyTemplate } from "./template"
import { Token } from "../../context/token"
import { Filesystem } from "@merakcode/util/filesystem"

/**
 * SessionMemory (per-session notes).
 *
 * Maintains structured notes (10 sections) that restore context after compaction.
 * Differences from persistent memory (MemoryExtract):
 * - Lifetime: one session (scoped by sessionID) vs across sessions (scoped by projectKey)
 * - Purpose: restoring context after compaction vs recall in later sessions
 * - Trigger: token thresholds vs signal detection
 *
 * Extraction runs in a forked child session on a small model, since there is no prompt cache to share.
 */
export namespace SessionMemory {
  const log = Log.create({ service: "session-memory" })
  const AGENT_NAME = "session-memory"
  const TITLE = "session memory"

  const CONFIG = {
    minimumTokensToInit: 10_000, // first extraction once the context reaches 10K tokens
    minimumTokensBetweenUpdate: 5_000, // next extraction after another 5K tokens
  }

  /** How long compaction waits for an in-flight extraction */
  const EXTRACTION_WAIT_TIMEOUT_MS = 15_000
  const EXTRACTION_STALE_THRESHOLD_MS = 60_000

  type Input = {
    session: Session.Info
    assistant: Message.AssistantInfo
    model: Message.UserInfo["model"]
    tokens: number
  }

  type State = {
    initialized: boolean
    lastTokens: number
    lastAssistantID?: string // cursor: last assistant message extracted
    inFlight?: Promise<void>
    pending?: Input
    extractionStartedAt?: number // read by compaction to wait for the extraction
  }

  const states = Instance.state(() => new Map<string, State>())

  /** Called by the runner at the end of a turn, next to MemoryExtract.schedule */
  export function schedule(input: Input) {
    if (input.session.parentID) return
    if (input.assistant.error) return
    const map = states()
    const state = map.get(input.session.id) ?? fresh()
    map.set(input.session.id, state)

    if (state.lastAssistantID === input.assistant.id) return
    if (state.pending?.assistant.id === input.assistant.id) return

    if (state.inFlight) {
      state.pending = input
      return
    }
    if (!shouldExtract(state, input)) return
    void run(input, state)
  }

  function fresh(): State {
    return { initialized: false, lastTokens: 0 }
  }

  function shouldExtract(state: State, input: Input): boolean {
    if (!state.initialized) {
      if (input.tokens < CONFIG.minimumTokensToInit) return false
      state.initialized = true
    }
    // Scheduling only happens at turn end, so no tool-call threshold is needed.
    return input.tokens - state.lastTokens >= CONFIG.minimumTokensBetweenUpdate
  }

  async function run(input: Input, state: State) {
    state.extractionStartedAt = Date.now()
    state.inFlight = runExtraction(input, state)
      .catch((error) => {
        log.warn("session memory extraction failed", {
          error,
          sessionID: input.session.id,
          assistantID: input.assistant.id,
        })
      })
      .finally(() => {
        state.inFlight = undefined
        state.extractionStartedAt = undefined
        // Trailing run: process the input stashed while this extraction was in flight.
        const pending = state.pending
        state.pending = undefined
        if (pending && pending.assistant.id !== state.lastAssistantID) {
          if (shouldExtract(state, pending)) void run(pending, state)
        }
      })
  }

  async function runExtraction(input: Input, state: State) {
    if (!(await enabled())) return

    const notesPath = SessionMemoryPath.file(input.session.id)
    await ensureNotesFile(notesPath)

    const child = await Session.forkAsChild({
      sessionID: input.session.id,
      parentID: input.session.id,
      title: TITLE,
      permission: sessionMemoryRules(),
      // Runs after the reply; the conversation does not read as running while it does
      metadata: { background: true },
    })
    const { Loop } = await import("../../loop/index")
    await Loop.promptGenerated({
      sessionID: child.id,
      agent: AGENT_NAME,
      model: await pickMemoryModel(input.model),
      permissionMode: "ask",
      maxTurns: 5,
      parts: [
        {
          type: "text",
          text: await prompt(notesPath),
          synthetic: true,
        },
      ],
    })
    // Advance the cursor only on success; a failed extraction is retried on a later turn.
    state.lastAssistantID = input.assistant.id
    state.lastTokens = input.tokens
  }

  /** Creates the notes file from the template unless it already exists */
  async function ensureNotesFile(notesPath: string) {
    await mkdir(path.dirname(notesPath), { recursive: true }).catch(() => undefined)
    await writeFile(notesPath, SESSION_MEMORY_TEMPLATE, { encoding: "utf-8", flag: "wx" }).catch(() => undefined)
  }

  /** Extraction prompt: keep the structure, edit in parallel, always update Current State */
  async function prompt(notesPath: string) {
    const current = await Filesystem.readText(notesPath).catch(() => SESSION_MEMORY_TEMPLATE)
    return [
      'IMPORTANT: This message and these instructions are NOT part of the actual user conversation. Do not mention "note-taking" or these update instructions in the notes.',
      "",
      "Based on the user conversation above (excluding this instruction message, the system prompt, AGENTS.md and any earlier summaries), update the session notes file.",
      `The current content of ${notesPath} is below (it is complete, so update the relevant sections with the Edit tool directly; no need to Read it first):`,
      "<current_notes_content>",
      current,
      "</current_notes_content>",
      "",
      "Your only task is to update the notes file with the Edit tool and then stop. You may issue all Edit calls in parallel in a single message. Do not call any other tools.",
      "",
      "Critical editing rules:",
      "- The file must keep its exact structure: every section, heading and italic description line stays intact",
      "-- Never modify, delete or add heading lines (starting with #)",
      "-- Never modify, delete or add the italic description lines (the _..._ line right after each heading; they are template instructions)",
      "-- Only update the content below the italic description lines",
      '- Skip a section when there is no substantial new insight; do not write filler such as "No information yet"',
      "- Write detailed, info-dense content for each section (file paths, function names, error messages, exact commands)",
      "- Keep each section under ~2000 tokens",
      "- IMPORTANT: Always update the Current State section (the second section) to reflect the latest work - this is critical for continuity after compaction",
      "",
      `Use the Edit tool with file_path: ${notesPath}`,
      sectionSizeReminder(current),
    ].join("\n")
  }

  /**
   * Asks the model to condense any section over 2000 tokens, or the whole file when it exceeds 12000 tokens.
   * Returns an empty string when no reminder is needed.
   */
  function sectionSizeReminder(content: string): string {
    const sections = content.split(/\n(?=#)/)
    const reminders: string[] = []
    let total = 0
    for (const section of sections) {
      const title = section.split("\n")[0] ?? ""
      const tokens = Token.estimate(section)
      total += tokens
      if (tokens > 2000) {
        reminders.push(`${title} ~${tokens} tokens (over the 2000 limit, please condense)`)
      }
    }
    if (total > 12000) {
      reminders.push(`Total ~${total} tokens (over the 12000 limit, please condense lower-priority sections)`)
    }
    if (reminders.length === 0) return ""
    return `\n\nSection size reminders:\n${reminders.join("\n")}`
  }

  /**
   * Permission sandbox: everything is denied except reading the workspace. The session's own summary.md is writable
   * without approval (isProjectFileBypass); no other file can be written.
   */
  function sessionMemoryRules() {
    return PermissionNext.fromConfig({ "*": "deny", read: "allow" })
  }

  /** On by default; disabled by setting memory.session_memory to false */
  export async function enabled(): Promise<boolean> {
    if (!Instance.has()) return false
    return (await Config.get()).memory?.session_memory !== false
  }

  /**
   * Reads the notes for injection during compaction.
   * Returns undefined when the feature is off, the file is missing, or it is still the empty template.
   */
  export async function content(sessionID: string): Promise<string | undefined> {
    if (!(await enabled())) return undefined
    const text = await Filesystem.readText(SessionMemoryPath.file(sessionID)).catch(() => undefined)
    if (!text?.trim() || isEmptyTemplate(text)) return undefined
    return text
  }

  /**
   * Waits for an in-flight extraction before compaction so it does not use outdated notes.
   * Gives up after 15s, or immediately when the extraction started more than 60s ago.
   */
  export async function waitForExtraction(sessionID: string): Promise<void> {
    const state = states().get(sessionID)
    if (!state?.extractionStartedAt) return
    const start = Date.now()
    while (state.extractionStartedAt) {
      if (Date.now() - state.extractionStartedAt > EXTRACTION_STALE_THRESHOLD_MS) return
      if (Date.now() - start > EXTRACTION_WAIT_TIMEOUT_MS) return
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  /**
   * Waits for in-flight extractions of all sessions. Called before process exit; best-effort, gives up on timeout.
   */
  export async function drain(timeoutMs = 5_000): Promise<void> {
    const map = states()
    const inflight: Promise<void>[] = []
    for (const state of map.values()) {
      if (state.inFlight) inflight.push(state.inFlight.catch(() => undefined))
    }
    if (inflight.length === 0) return
    await Promise.race([Promise.all(inflight), new Promise((resolve) => setTimeout(resolve, timeoutMs))])
  }
}
