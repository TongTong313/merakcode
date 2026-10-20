import path from "path"
import { fileURLToPath } from "url"
import { SessionToolResult } from "../session/tool-result"
import { isLifecycleReplacement } from "../session/read-lifecycle"
import type { Message } from "../session/message"
import { RuleSession } from "./session-state"

/**
 * Working set for glob rules: the file paths the current request is dealing with.
 * Recomputed for every LLM request and never pinned.
 */
export namespace RuleWorkingSet {
  export const RECENT_TURNS = 2

  const FILE_TOOLS = new Set(["read", "write", "edit", "multi_edit"])

  function resolvePath(filepath: string) {
    return path.resolve(filepath)
  }

  function isCompactionControl(msg: Message.FullMsg) {
    return msg.info.role === "user" && msg.parts.length > 0 && msg.parts.every((part) => part.type === "compaction")
  }

  function lastUserMessage(messages: Message.FullMsg[]) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.info.role !== "user") continue
      if (isCompactionControl(msg)) continue
      return msg
    }
  }

  function fileUrlPath(url: string): string | undefined {
    if (!url.startsWith("file:")) return
    try {
      return fileURLToPath(url)
    } catch {
      return
    }
  }

  /** A: files (not directories) @-mentioned in the current user message */
  export function fromMentions(messages: Message.FullMsg[]) {
    const user = lastUserMessage(messages)
    if (!user) return [] as string[]
    const out: string[] = []
    for (const part of user.parts) {
      if (part.type !== "file") continue
      if (part.mime === "application/x-directory") continue
      if (part.mime === "application/x-merakcode-session") continue
      const filepath = fileUrlPath(part.url)
      if (filepath) out.push(resolvePath(filepath))
    }
    return out
  }

  function toolFilePaths(part: Message.ToolPart): string[] {
    if (part.state.status !== "completed") return []
    if (!FILE_TOOLS.has(part.tool)) return []
    const input = part.state.input ?? {}
    const filePath = input.filePath
    if (typeof filePath !== "string" || !filePath) return []
    return [resolvePath(filePath)]
  }

  function hasFileBody(part: Message.ToolPart) {
    if (part.state.status !== "completed") return false
    if (part.state.time.compacted) return false
    const output = part.state.output ?? ""
    if (output === SessionToolResult.PLACEHOLDER) return false
    if (isLifecycleReplacement(output)) return false
    return true
  }

  /**
   * C: files of read/write/edit/multi_edit calls whose content is still in the projected prompt (excluding earlier
   * @-mentioned files, which are A)
   */
  export function fromPromptContent(messages: Message.FullMsg[]) {
    const out: string[] = []
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type === "tool" && hasFileBody(part)) {
          out.push(...toolFilePaths(part))
        }
      }
    }
    return out
  }

  /** D: files read, written or edited in the last N user turns (from the session rule state) */
  export function fromRecent(
    data: { recentFiles: RuleSession.RecentFile[]; userTurns: string[] },
    recentTurns = RECENT_TURNS,
  ) {
    const allowed = new Set(data.userTurns.slice(-recentTurns))
    if (allowed.size === 0) return [] as string[]
    return data.recentFiles.filter((item) => allowed.has(item.userMessageID)).map((item) => item.path)
  }

  export async function collect(input: { sessionID: string; messages: Message.FullMsg[] }): Promise<string[]> {
    const data = await RuleSession.snapshot(input.sessionID)
    const seen = new Set<string>()
    const out: string[] = []
    const push = (filepath: string) => {
      const resolved = resolvePath(filepath)
      if (seen.has(resolved)) return
      seen.add(resolved)
      out.push(resolved)
    }
    for (const filepath of fromMentions(input.messages)) push(filepath)
    for (const filepath of fromPromptContent(input.messages)) push(filepath)
    for (const filepath of fromRecent(data)) push(filepath)
    return out
  }
}
