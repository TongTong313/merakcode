import path from "path"
import { FileTime } from "../file/time"
import { Flag } from "../flag/flag"
import type { Message } from "./message"
import { ContextClaims } from "./context-claims"
import { InstructionPrompt } from "./instruction"
import { Filesystem } from "@merakcode/util/filesystem"

/**
 * File-level instruction injection: when a tool touches a file, each provider decides which instructions to attach.
 * AGENTS.md and rules are separate providers that share the same triggers, dedup ledger and rendering, so there are
 * no two injection paths with diverging behavior.
 */
export namespace ContextAttach {
  /**
   * Injection layers. The value is the precedence: lower is general, higher is specific. Items render in ascending
   * order, which together with "the later one wins on conflict" makes more specific instructions take precedence.
   * Rule layers come from Rule.LAYER; both sets of values must match (enforced by a test).
   */
  export const Layer = {
    GLOBAL_USER: 10,
    EXTERNAL_RULE: 20,
    AGENTS_MD: 30,
    NATIVE_RULE: 40,
    DYNAMIC: 50,
  } as const

  export const PRECEDENCE_NOTE = InstructionPrompt.PRECEDENCE_NOTE

  /** Max hit directories that get instructions on a search, so hundreds of hits do not flood the output */
  export const SEARCH_DIRECTORY_LIMIT = 3

  /** Max hit files per directory used for rule glob matching on a search */
  export const SEARCH_FILE_SAMPLE = 50

  /** Byte limit for instructions attached to one tool output; attaching stops once exceeded */
  export const MAX_ATTACH_BYTES = 32 * 1024

  /**
   * Byte limit for per-turn reaffirmation. It goes through the user-context channel and is resent every turn, so the
   * budget is tighter than for a one-off attachment.
   */
  export const MAX_REAFFIRM_BYTES = 8 * 1024

  /** Tool actions that trigger injection */
  export type Trigger = "read" | "write" | "edit" | "list" | "search"

  export type Reason = "nested-agents" | "glob" | "intelligent" | "manual"

  export type Item = {
    layer: number
    filepath: string
    content: string
    reason: Reason
  }

  export type Input = {
    filepath: string
    trigger: Trigger
    messageID: string
    messages: Message.FullMsg[]
    /** filepath is a directory: include the directory itself when walking up */
    directory?: boolean
    /** Current agent, for the rules' agents filter; no filtering when omitted */
    agent?: string
    /**
     * Sample of hit files for a search. Rule globs target files (`src/**` + `/*.ts`) and almost never match a bare
     * directory, so searches pass real file paths.
     */
    files?: string[]
  }

  export type Provider = {
    id: string
    forFile(input: Input): Promise<Item[]>
  }

  const AGENTS_MD: Provider = {
    id: "agents-md",
    async forFile(input) {
      const found = await InstructionPrompt.resolve(input.messages, input.filepath, input.messageID, {
        includeSelf: input.directory,
      })
      return found.map((item) => ({
        layer: Layer.AGENTS_MD,
        filepath: item.filepath,
        content: item.content,
        reason: "nested-agents" as const,
      }))
    },
  }

  /**
   * Rule bodies no longer go into tool output; RulesPrompt.active puts glob/pinned rules into user-context every turn.
   * The provider stays so tests and the register contract keep working; forFile always returns nothing.
   */
  const RULES: Provider = {
    id: "rules",
    async forFile() {
      return []
    },
  }

  const providers: Provider[] = [AGENTS_MD, RULES]

  export function register(provider: Provider) {
    const index = providers.findIndex((p) => p.id === provider.id)
    if (index >= 0) providers[index] = provider
    else providers.push(provider)
  }

  export function unregister(id: string) {
    const index = providers.findIndex((p) => p.id === id)
    if (index >= 0) providers.splice(index, 1)
  }

  export function registered() {
    return providers.slice()
  }

  /**
   * Runs providers sequentially: the dedup ledger applies in call order, so running them one by one is what makes a
   * file consistently belong to the first registered provider.
   */
  export async function forFile(input: Input): Promise<Item[]> {
    const result: Item[] = []
    for (const provider of providers) {
      result.push(...(await provider.forFile(input)))
    }
    return result
  }

  /**
   * Instructions for the hits of a search tool. Only the directories with the most hits are used, so a grep with
   * hundreds of hits does not inject for dozens of directories.
   */
  export async function forSearchHits(input: {
    files: string[]
    messageID: string
    messages: Message.FullMsg[]
    limit?: number
    agent?: string
  }): Promise<Item[]> {
    const byDir = new Map<string, string[]>()
    for (const file of input.files) {
      const resolved = path.resolve(file)
      const dir = path.dirname(resolved)
      const list = byDir.get(dir)
      if (list) list.push(resolved)
      else byDir.set(dir, [resolved])
    }
    const dirs = Array.from(byDir.entries())
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .slice(0, input.limit ?? SEARCH_DIRECTORY_LIMIT)

    const result: Item[] = []
    for (const [dir, files] of dirs) {
      result.push(
        ...(await forFile({
          filepath: dir,
          trigger: "search",
          directory: true,
          messageID: input.messageID,
          messages: input.messages,
          agent: input.agent,
          files,
        })),
      )
    }
    return result
  }

  export function clear(messageID: string) {
    ContextClaims.clear(messageID)
  }

  /**
   * Re-injects, every turn, the instruction files of directories this session has touched. A one-off reminder in tool
   * output gets buried as turns accumulate, while "applies when working on files in this directory" is an ongoing
   * condition that needs restating.
   *
   * Uses the user-context channel rather than system: a system prefix that changes every turn breaks the provider's
   * prompt cache and costs more.
   */
  export async function reaffirm(sessionID: string): Promise<string[]> {
    if (Flag.MERAKCODE_DISABLE_INSTRUCTION_REAFFIRM) return []
    const touched = FileTime.state().read[sessionID]
    if (!touched) return []

    const system = await InstructionPrompt.systemPaths()
    const found: string[] = []
    const seen = new Set<string>()
    for (const filepath of Object.keys(touched)) {
      for (const item of await InstructionPrompt.chainFor(filepath)) {
        if (system.has(item) || seen.has(item)) continue
        seen.add(item)
        found.push(item)
      }
    }
    if (found.length === 0) return []

    // Shallow to deep, matching PRECEDENCE_NOTE
    found.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b))

    const blocks: string[] = []
    let used = 0
    for (const item of found) {
      const content = await Filesystem.readText(item).catch(() => "")
      if (!content) continue
      const block = "Instructions from: " + item + "\n" + content
      if (used + block.length > MAX_REAFFIRM_BYTES) break
      used += block.length
      blocks.push(block)
    }
    if (blocks.length === 0) return []
    return [[PRECEDENCE_NOTE, "", ...blocks].join("\n")]
  }

  /** Renders a system-reminder block to append to tool output; returns an empty string when there is nothing */
  export function render(items: Item[]) {
    if (items.length === 0) return ""
    const ordered = items.slice().sort((a, b) => a.layer - b.layer)
    const blocks: string[] = []
    let used = 0
    for (const item of ordered) {
      if (used + item.content.length > MAX_ATTACH_BYTES) break
      used += item.content.length
      blocks.push(item.content)
    }
    if (blocks.length === 0) return ""
    return `\n\n<system-reminder>\n${PRECEDENCE_NOTE}\n\n${blocks.join("\n\n")}\n</system-reminder>`
  }
}
