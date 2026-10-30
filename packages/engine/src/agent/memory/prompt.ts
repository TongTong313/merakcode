import fs from "fs/promises"
import { Config } from "@merakcode/engine/agent/settings/index"
import { Instance } from "../../infra/project/instance"
import { MemoryPath } from "./path"
import { resolveExtractPolicy } from "./util"
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  TRUSTING_RECALL_SECTION,
  TYPES_SECTION_INDIVIDUAL,
  WHAT_NOT_TO_SAVE_SECTION,
  WHEN_TO_ACCESS_SECTION,
} from "./types"

export namespace MemoryPrompt {
  export const MAX_ENTRYPOINT_LINES = 200
  export const MAX_ENTRYPOINT_BYTES = 25_000

  const DIR_EXISTS_GUIDANCE =
    "This directory already exists - write to it directly with the Write tool (do not run mkdir or check for its existence)."

  export async function system() {
    const dir = MemoryPath.directory()
    await Promise.all([dir, ...MemoryPath.typeDirs()].map(ensure))
    return [await buildMemoryPrompt(dir)]
  }

  /**
   * Whether to inject the memory system instructions: yes when extraction is on (the default, signals) or recall is
   * explicitly on; no only when extraction is explicitly off and recall is off.
   * Returns false without an Instance context (e.g. pure unit tests) to avoid depending on config.
   */
  async function enabled(): Promise<boolean> {
    if (!Instance.has()) return false
    const mem = (await Config.get()).memory
    return resolveExtractPolicy(mem?.auto_extract) !== "off" || mem?.auto_recall === true
  }

  /** Memory instructions when enabled by config; an empty array otherwise, leaving the system prompt unaffected */
  export async function maybeSystem(): Promise<string[]> {
    if (!(await enabled())) return []
    return system()
  }

  async function ensure(dir: string) {
    await fs.mkdir(dir, { recursive: true }).catch(() => undefined)
  }

  async function buildMemoryPrompt(memoryDir: string) {
    const lines = buildMemoryLines("auto memory", memoryDir)
    const entrypoint = await fs.readFile(MemoryPath.entrypoint(), "utf8").catch(() => "")

    if (entrypoint.trim()) {
      lines.push(`## ${MemoryPath.ENTRYPOINT_NAME}`, "", truncateEntrypointContent(entrypoint))
    } else {
      lines.push(
        `## ${MemoryPath.ENTRYPOINT_NAME}`,
        "",
        `Your ${MemoryPath.ENTRYPOINT_NAME} is currently empty. When you save new memories, they will appear here.`,
      )
    }

    return lines.join("\n")
  }

  function buildMemoryLines(displayName: string, memoryDir: string) {
    const howToSave = [
      "## How to save memories",
      "",
      "Saving a memory is a two-step process:",
      "",
      "**Step 1** - write the memory to its own file in the matching type subdirectory (e.g., `user/user_role.md`, `feedback/feedback_testing.md`) using this frontmatter format:",
      "",
      ...MEMORY_FRONTMATTER_EXAMPLE,
      "",
      `**Step 2** - add a pointer to that file in \`${MemoryPath.ENTRYPOINT_NAME}\`. \`${MemoryPath.ENTRYPOINT_NAME}\` is an index, not a memory - each entry should be one line, under ~150 characters: \`- [Title](file.md) - one-line hook\`. It has no frontmatter. Never write memory content directly into \`${MemoryPath.ENTRYPOINT_NAME}\`.`,
      "",
      `- \`${MemoryPath.ENTRYPOINT_NAME}\` is always loaded into your conversation context - lines after ${MAX_ENTRYPOINT_LINES} will be truncated, so keep the index concise`,
      "- Store each memory file in the subdirectory matching its `type`: `user/`, `feedback/`, `project/`, or `reference/`. Do not write topic memory files at the memory root.",
      "- Keep the name, description, and type fields in memory files up-to-date with the content",
      "- Organize memory semantically by topic, not chronologically",
      "- Update or remove memories that turn out to be wrong or outdated",
      `- Do not write duplicate memories. First check \`${MemoryPath.ENTRYPOINT_NAME}\` and the relevant type subdirectory to see if there is an existing memory you can update before writing a new one.`,
    ]

    return [
      `# ${displayName}`,
      "",
      `You have a persistent, file-based memory system at \`${memoryDir}\`. ${DIR_EXISTS_GUIDANCE}`,
      "",
      "Memory files are organized by type under this directory:",
      `- user: \`${MemoryPath.typeDir("user")}\``,
      `- feedback: \`${MemoryPath.typeDir("feedback")}\``,
      `- project: \`${MemoryPath.typeDir("project")}\``,
      `- reference: \`${MemoryPath.typeDir("reference")}\``,
      "",
      `Keep \`${MemoryPath.ENTRYPOINT_NAME}\` at the memory root as the index. Write topic memory files only inside the type subdirectories.`,
      "",
      "You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
      "",
      "If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.",
      "",
      ...TYPES_SECTION_INDIVIDUAL,
      ...WHAT_NOT_TO_SAVE_SECTION,
      "",
      ...howToSave,
      "",
      ...WHEN_TO_ACCESS_SECTION,
      "",
      "## Memory loading priority",
      "",
      `- The memory rules and \`${MemoryPath.ENTRYPOINT_NAME}\` index are loaded as context first; topic memory files are read only when relevant or when the user asks you to check, recall, or remember.`,
      "- If memory conflicts with the current project state, trust what you observe by reading files, running safe commands, or checking current resources.",
      "- If memory conflicts with AGENTS.md instructions, follow AGENTS.md and update or remove the stale memory when appropriate.",
      "- If a topic memory is needed, read the specific file listed in the index rather than scanning unrelated memory files.",
      "",
      ...TRUSTING_RECALL_SECTION,
      "",
      "## Memory and other forms of persistence",
      "Memory is one of several persistence mechanisms available to you as you assist the user in a given conversation. The distinction is often that memory can be recalled in future conversations and should not be used for persisting information that is only useful within the scope of the current conversation.",
      "- When to use or update a plan instead of memory: If you are about to start a non-trivial implementation task and would like to reach alignment with the user on your approach you should use a Plan rather than saving this information to memory. Similarly, if you already have a plan within the conversation and you have changed your approach persist that change by updating the plan rather than saving a memory.",
      "- When to use or update tasks instead of memory: When you need to break your work in current conversation into discrete steps or keep track of your progress use tasks instead of saving to memory. Tasks are great for persisting information about the work that needs to be done in the current conversation, but memory should be reserved for information that will be useful in future conversations.",
      "",
    ]
  }

  function truncateEntrypointContent(raw: string) {
    const trimmed = raw.trim()
    const lines = trimmed.split("\n")
    const lineCount = lines.length
    const byteCount = Buffer.byteLength(trimmed, "utf8")
    const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES
    const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES

    if (!wasLineTruncated && !wasByteTruncated) return trimmed

    let truncated = wasLineTruncated ? lines.slice(0, MAX_ENTRYPOINT_LINES).join("\n") : trimmed
    if (Buffer.byteLength(truncated, "utf8") > MAX_ENTRYPOINT_BYTES) {
      let size = 0
      const kept: string[] = []
      for (const line of truncated.split("\n")) {
        const next = Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0)
        if (size + next > MAX_ENTRYPOINT_BYTES) break
        kept.push(line)
        size += next
      }
      truncated = kept.join("\n")
    }

    const reason =
      wasByteTruncated && !wasLineTruncated
        ? `${byteCount} bytes (limit: ${MAX_ENTRYPOINT_BYTES}) - index entries are too long`
        : wasLineTruncated && !wasByteTruncated
          ? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
          : `${lineCount} lines and ${byteCount} bytes`

    return `${truncated}\n\n> WARNING: ${MemoryPath.ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`
  }
}
