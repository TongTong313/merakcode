import path from "path"
import { Message } from "./message"
import { Identifier } from "@merakcode/util/id"
import { Todo } from "./todo"
import { Session } from "."
import { FileTime } from "../file/time"
import { ReadTool } from "../tool/read"
import { InstructionPrompt } from "./instruction"
import { Skill } from "../skill/skill"
import { Token } from "../util/token"
import { Flag } from "../flag/flag"
import { Log } from "@merakcode/log/logger"
import { PermissionMode } from "../permission/mode"
import type { Provider } from "../provider/provider"
import type { Tool } from "../tool/tool"
import { truncateSections } from "../session-memory/template"
import { Filesystem } from "@merakcode/util/filesystem"

/**
 * Post-compaction attachment restore: appends synthetic TextParts to the continuation user message created by
 * compaction, re-injecting context lost to compaction (unfinished todos, plan file, recently read files, loaded
 * skills). This gives the model a clear signal that work remains, so it keeps going instead of stopping to summarize.
 *
 * These parts sit after the compaction parent message, so Message.filterCompacted keeps them and
 * Message.toModelMessages sends them as separate text parts of the continuation user message (not merged, ordered by
 * id).
 */
export namespace SessionCompactionRestore {
  const log = Log.create({ service: "session.compaction.restore" })

  const MAX_RECENT_FILES = 5
  // Total token budget for restored files
  const POST_COMPACT_FILE_TOKEN_BUDGET = 50_000
  // Per-file token cap; longer files keep only their head
  const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000
  const POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000
  // Total token budget for restored skills
  const POST_COMPACT_SKILLS_TOKEN_BUDGET = 25_000

  const SKILL_TRUNCATION_MARKER =
    "\n\n[... skill content truncated due to compaction-restore budget; use Read on the skill file for the full text]"

  const FILE_TRUNCATION_MARKER =
    "\n\n[... file content truncated due to compaction-restore budget; use the Read tool to re-read the file]"

  export async function attachments(input: {
    sessionID: string
    /** Continuation user message that the restored parts are attached to */
    messageID: string
    messages: Message.FullMsg[]
    model: Provider.Model
    /** Agent active when compaction ran; used for the ReadTool pre-read context */
    agent: string
  }): Promise<Message.TextPart[]> {
    // Each call gets a monotonically increasing part id, so toModelMessages keeps the order
    // todos, plan, recent files, skills.
    const make = (text: string): Message.TextPart => ({
      id: Identifier.ascending("part"),
      sessionID: input.sessionID,
      messageID: input.messageID,
      type: "text",
      synthetic: true,
      text,
      time: { start: Date.now(), end: Date.now() },
    })

    const parts: Message.TextPart[] = []

    try {
      const text = await restoreTodos(input.sessionID)
      if (text) parts.push(make(text))
    } catch (e) {
      log.error("restore todos failed", { error: e })
    }

    try {
      const text = await restorePlan(input.sessionID)
      if (text) parts.push(make(text))
    } catch (e) {
      log.error("restore plan failed", { error: e })
    }

    try {
      for (const text of await restoreRecentFiles(input.sessionID, input.model, input.agent)) {
        parts.push(make(text))
      }
    } catch (e) {
      log.error("restore recent files failed", { error: e })
    }

    try {
      for (const text of await restoreSkills(input.messages)) {
        parts.push(make(text))
      }
    } catch (e) {
      log.error("restore skills failed", { error: e })
    }

    try {
      const text = await restoreSessionMemory(input.sessionID)
      if (text) parts.push(make(text))
    } catch (e) {
      log.error("restore session memory failed", { error: e })
    }

    return parts
  }

  /** Restores unfinished todos as a system-reminder */
  async function restoreTodos(sessionID: string): Promise<string | undefined> {
    const todos = await Todo.get(sessionID)
    const active = todos.filter((t) => t.status !== "completed" && t.status !== "cancelled")
    if (active.length === 0) return undefined
    const lines = active.map((t) => `- [${t.status}] ${t.content}`)
    return [
      "<system-reminder>",
      "Unfinished todos restored after compaction (please continue advancing them):",
      ...lines,
      "</system-reminder>",
    ].join("\n")
  }

  /** Restores the plan file, only when plan mode is enabled and the file exists */
  async function restorePlan(sessionID: string): Promise<string | undefined> {
    if (!Flag.MERAKCODE_PLAN_MODE) return undefined
    const session = await Session.get(sessionID)
    if (!session) return undefined
    const plan = Session.plan(session)
    const exists = await Filesystem.isFile(plan)
    if (!exists) return undefined
    const content = await Filesystem.readText(plan).catch(() => "")
    if (!content.trim()) return undefined
    return [
      "<system-reminder>",
      `Current plan file (${plan}), restored after compaction — continue executing it:`,
      content,
      "</system-reminder>",
    ].join("\n")
  }

  /**
   * Restores recently read files using the runner.ts pre-read mode (bypassCwdCheck and an empty ruleset).
   * Takes the newest MAX_RECENT_FILES by FileTime read time, within the total and per-file token budgets.
   * Skips the instruction files that InstructionPrompt.system() injects every turn.
   */
  async function restoreRecentFiles(sessionID: string, model: Provider.Model, agent: string): Promise<string[]> {
    const readMap = FileTime.state().read[sessionID]
    if (!readMap) return []

    const entries = Object.entries(readMap)
      .filter(([, d]) => d instanceof Date)
      .sort((a, b) => (b[1] as Date).getTime() - (a[1] as Date).getTime())
      .slice(0, MAX_RECENT_FILES)

    const tool = await ReadTool.init()
    // Match by path, not file name: a subdirectory AGENTS.md is not in system(), and skipping it by name would lose
    // it for good after compaction.
    const systemInstructions = await InstructionPrompt.systemPaths()
    const results: string[] = []
    let usedTokens = 0

    for (const [filepath] of entries) {
      if (systemInstructions.has(path.resolve(filepath))) continue

      const args = { filePath: filepath }
      // Same as the pre-read branch of runner.createUserMessage: bypassCwdCheck skips directory and permission
      // checks, with an empty ruleset and a no-op ask.
      const readCtx: Tool.Context = {
        sessionID,
        abort: new AbortController().signal,
        agent,
        permissionMode: PermissionMode.DEFAULT,
        kind: PermissionMode.DEFAULT,
        messageID: "",
        extra: { bypassCwdCheck: true, model },
        messages: [],
        ruleset: [],
        metadata: async () => {},
        ask: async () => {},
      }

      let output: string
      try {
        const result = await tool.execute(args, readCtx)
        output = result.output ?? ""
      } catch (e) {
        log.warn("re-read file failed during compaction restore", { filepath, error: String(e) })
        continue
      }
      if (!output.trim()) continue

      if (Token.estimate(output) > POST_COMPACT_MAX_TOKENS_PER_FILE) {
        const charBudget = POST_COMPACT_MAX_TOKENS_PER_FILE * 4
        output = output.slice(0, charBudget) + FILE_TRUNCATION_MARKER
      }

      const estimate = Token.estimate(output)
      if (usedTokens + estimate > POST_COMPACT_FILE_TOKEN_BUDGET) break
      usedTokens += estimate

      // Same format as the createUserMessage pre-read, so the model sees it as a Read tool result
      results.push(`Called the Read tool with the following input: ${JSON.stringify(args)}\n${output}`)
    }

    return results
  }

  /**
   * Restores loaded skills: collects input.name from completed skill tool calls in history, dedupes them and reads
   * each body with Skill.get, within the per-skill and total token budgets.
   */
  async function restoreSkills(messages: Message.FullMsg[]): Promise<string[]> {
    // Dedupe while keeping first-seen order
    const seen = new Set<string>()
    const names: string[] = []
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type !== "tool" || part.tool !== "skill") continue
        if (part.state.status !== "completed") continue
        const name = (part.state.input as { name?: unknown } | undefined)?.name
        if (typeof name === "string" && name.trim() && !seen.has(name)) {
          seen.add(name)
          names.push(name)
        }
      }
    }
    if (names.length === 0) return []

    const results: string[] = []
    let usedTokens = 0

    for (const name of names) {
      const skill = await Skill.get(name)
      if (!skill?.content?.trim()) continue

      let content = skill.content
      if (Token.estimate(content) > POST_COMPACT_MAX_TOKENS_PER_SKILL) {
        const charBudget = POST_COMPACT_MAX_TOKENS_PER_SKILL * 4 - SKILL_TRUNCATION_MARKER.length
        content = content.slice(0, Math.max(0, charBudget)) + SKILL_TRUNCATION_MARKER
      }

      const estimate = Token.estimate(content)
      if (usedTokens + estimate > POST_COMPACT_SKILLS_TOKEN_BUDGET) break
      usedTokens += estimate

      // Same format as the SkillTool output
      results.push(`<skill_content name="${name}">\n${content}\n</skill_content>`)
    }

    return results
  }

  /**
   * Restores SessionMemory notes, only when the feature is enabled and the notes are not empty.
   * Each section is truncated to ~2000 tokens so the notes do not fill the post-compaction budget.
   *
   * SessionMemory is imported dynamically to avoid the static cycle
   * session -> compaction-restore -> SessionMemory -> session.
   */
  async function restoreSessionMemory(sessionID: string): Promise<string | undefined> {
    const { SessionMemory } = await import("../session-memory/session-memory")
    const content = await SessionMemory.content(sessionID)
    if (!content) return undefined // feature disabled, file missing, or empty template
    const truncated = truncateSections(content, 2000)
    return [
      "<system-reminder>",
      "Session memory (session notes, restored after compaction):",
      truncated,
      "</system-reminder>",
    ].join("\n")
  }
}
