import { Instance } from "../project/instance"
import { Process } from "@merakcode/util/process"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_ANTHROPIC_WITHOUT_TODO from "./prompt/qwen.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"

import PROMPT_CODEX from "./prompt/codex_header.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import PROMPT_SECURE_CODING from "./prompt/secure-coding.txt"
import type { Provider } from "../provider/provider"
import type { Message } from "./message"

export namespace SystemPrompt {
  const GIT_SNAPSHOT_LIMIT = 4_000
  const GIT_COMMAND_TIMEOUT = 500
  /** Tools that can modify, run or review code */
  const CODE_TOOLS = new Set(["bash", "bash_background", "write", "edit", "multi_edit", "subagent", "workflow_run"])

  /**
   * Fills the prompt's only placeholder, {{surface}}: where replies are shown. The desktop app renders Markdown in a
   * window; everything else (terminal, ACP editors) is described as a terminal.
   * Plugins can rewrite the system prompt with the `experimental.chat.system.transform` hook.
   */
  function render(template: string) {
    return template.replaceAll(
      "{{surface}}",
      process.env.MERAKCODE_CLIENT === "desktop" ? "the MerakCode desktop app" : "a terminal",
    )
  }

  /**
   * Injects secure coding rules only into sessions that can modify, run or review code.
   * Custom agents without a profile use the standard tool pool and are conservatively treated as coding agents;
   * narrow agents such as title/summary/compaction have explicit readonly pools and get no extra context.
   */
  export function secureCoding(agent: { profile?: { availableTools: readonly string[] } }) {
    const tools = agent.profile?.availableTools
    if (tools && !tools.some((tool) => CODE_TOOLS.has(tool))) return []
    return [PROMPT_SECURE_CODING.trim()]
  }

  /**
   * The prompt is in English, and without this the model often answers Chinese questions in English. It goes right
   * after the first paragraph (the identity): at the end, the English examples in the prompt often won out (in tests
   * on Linux, half the replies were in English).
   */
  const LANGUAGE =
    "IMPORTANT: Always reply in the language of the user's latest message (for example, answer Chinese questions in Chinese), unless the user asks for another language. Keep code, identifiers, commands and file paths as they are."

  export function provider(model: Provider.Model) {
    const text = render(template(model))
    const end = text.indexOf("\n\n")
    if (end < 0) return [text.trimEnd() + "\n\n" + LANGUAGE]
    return [text.slice(0, end) + "\n\n" + LANGUAGE + text.slice(end)]
  }

  /**
   * Names the reply language at the end of the system prompt, based on the latest message the user wrote. With only
   * the general instruction at the top, the model often switches to English after a few rounds of (English) tool
   * output. CJK characters must be at least as many as English words, so a few quoted characters in an English
   * question do not count. When undecided, nothing is added and the general instruction applies.
   */
  export function replyLanguage(messages: Message.FullMsg[]) {
    const text = messages
      .filter((msg) => msg.info.role === "user")
      .map((msg) =>
        msg.parts
          .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
          .join("\n"),
      )
      .findLast((text) => text.trim())
    if (!text) return []
    const count = (pattern: RegExp) => text.match(pattern)?.length ?? 0
    const cjk = count(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)
    if (!cjk || cjk < count(/[A-Za-z]+/g)) return []
    const name = count(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu)
      ? "Japanese"
      : count(/\p{Script=Hangul}/gu)
        ? "Korean"
        : "Chinese"
    return [
      `The user writes in ${name}. Reply to the user in ${name}, including the final summary after tool calls; keep code, identifiers, commands and file paths as they are.`,
    ]
  }

  function template(model: Provider.Model) {
    if (model.api.id.includes("gpt-5")) return PROMPT_CODEX
    if (model.api.id.includes("gpt-") || model.api.id.includes("o1") || model.api.id.includes("o3")) return PROMPT_BEAST
    if (model.api.id.includes("gemini-")) return PROMPT_GEMINI
    if (model.api.id.includes("claude")) return PROMPT_ANTHROPIC
    if (model.api.id.toLowerCase().includes("trinity")) return PROMPT_TRINITY
    return PROMPT_ANTHROPIC_WITHOUT_TODO
  }

  export function systemContext(model: Provider.Model) {
    return [
      [
        "<system-context>",
        `  Model: ${model.providerID}/${model.api.id}`,
        `  Current date: ${new Date().toDateString()}`,
        "</system-context>",
      ].join("\n"),
    ]
  }

  export async function userContext() {
    const project = Instance.project
    const workspace = Instance.workspace
    const git = await gitSnapshot()
    const folderLines =
      workspace.folders.length > 1
        ? [
            `  Workspace folders:`,
            ...workspace.folders.map((f) => {
              const vcs = f.worktree !== "/" ? "git" : "no-git"
              return `    - ${f.name}: ${f.path} (${vcs})`
            }),
          ]
        : []
    return [
      [
        `Useful information about the current session and environment:`,
        `<env>`,
        `  Working directory: ${Instance.directory}`,
        workspace.folders.length > 1 ? `  Primary working directory: ${workspace.primary}` : "",
        ...folderLines,
        `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
        `  Platform: ${process.platform}`,
        `</env>`,
        git ? ["<git-status>", git, "</git-status>"].join("\n") : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ]
  }

  async function gitSnapshot() {
    if (Instance.project.vcs !== "git") return ""

    const [branch, status, recent] = await Promise.all([
      git(["branch", "--show-current"]),
      git(["status", "--short", "--branch"]),
      git(["log", "--oneline", "-n", "5"]),
    ])
    const snapshot = [
      branch ? `Branch: ${branch}` : "",
      status ? ["Status:", status].join("\n") : "",
      recent ? ["Recent commits:", recent].join("\n") : "",
    ]
      .filter(Boolean)
      .join("\n\n")

    return truncate(snapshot, GIT_SNAPSHOT_LIMIT)
  }

  async function git(args: string[]) {
    try {
      const proc = Process.spawn(["git", ...args], {
        cwd: Instance.directory,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: "0",
        },
        stdout: "pipe",
        stderr: "ignore",
      })
      const timer = setTimeout(() => proc.kill(), GIT_COMMAND_TIMEOUT)
      const [output, code] = await Promise.all([
        new Response(proc.stdout).text().catch(() => ""),
        proc.exited.catch(() => 1),
      ]).finally(() => clearTimeout(timer))
      if (code !== 0) return ""
      return output.trim()
    } catch {
      return ""
    }
  }

  function truncate(input: string, limit: number) {
    if (input.length <= limit) return input
    return input.slice(0, limit) + "\n... truncated ..."
  }
}
