// MerakCode's own adapter, generated from packages/engine/src/collaboration/adapters/claude.ts. Do not edit.
/**
 * Built-in member adapter for Claude Code. It runs `claude -p` with stream-json in and out and the stdio permission
 * host, so every tool Claude Code would ask about comes to MerakCode first; AskUserQuestion becomes a MerakCode
 * question. Written with the adapter library alone, the same way anyone's adapter is.
 */
import readline from "node:readline"
import { adapter, spawn, stop, version } from "./merakcode-adapter.mjs"
/** Edits are not offered at all in read-only mode, so Claude Code does not try them */
const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"]
/** Arguments for one task; they are given again on resume, since Claude Code keeps none of them */
function claudeArgs(input) {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-prompt-tool",
    "stdio",
    // Everything Claude Code is unsure about goes to MerakCode, which applies the group's mode
    "--permission-mode",
    "default",
    ...(input.mode === "readonly" ? ["--disallowedTools", ...EDIT_TOOLS] : []),
    ...(input.resume ? ["--resume", input.resume] : []),
    ...(input.extra ?? []),
  ]
}
/** What MerakCode is asked for a tool Claude Code wants to use */
function claudeRequest(name, input) {
  const text = (key) => (typeof input[key] === "string" ? input[key] : "")
  if (EDIT_TOOLS.includes(name)) return { kind: "write", paths: [text("file_path") || text("notebook_path")] }
  if (name === "Read") return { kind: "read", paths: [text("file_path")] }
  if (name === "Bash") return { kind: "command", command: text("command") }
  if (name === "WebFetch") {
    const url = text("url")
    return { kind: "network", host: URL.canParse(url) ? new URL(url).hostname : url, url }
  }
  if (name === "WebSearch") return { kind: "network", host: "api.anthropic.com", url: text("query") }
  return { kind: "tool", name, detail: text("command") || text("file_path") || text("url") || undefined }
}
/** AskUserQuestion's questions as MerakCode questions */
function questionsOf(input) {
  const list = Array.isArray(input.questions) ? input.questions : []
  return list.map((item) => ({
    question: String(item.question ?? ""),
    header: String(item.header ?? ""),
    options: Array.isArray(item.options)
      ? item.options.map((option) => ({
          label: String(option.label ?? ""),
          description: String(option.description ?? ""),
        }))
      : [],
    multiple: item.multiSelect === true,
  }))
}
/** MerakCode's decision as Claude Code's permission response */
async function answer(host, name, input) {
  if (name === "AskUserQuestion") {
    const questions = questionsOf(input)
    const answers = await host.question(questions)
    // Claude Code reads the answers from the tool input, keyed by each question's text
    return {
      behavior: "allow",
      updatedInput: {
        ...input,
        answers: Object.fromEntries(questions.map((item, index) => [item.question, (answers[index] ?? []).join(", ")])),
      },
    }
  }
  const verdict = await host.permission(claudeRequest(name, input))
  return verdict.allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: verdict.message }
}
/** The step a tool_use block shows in the member's bubble */
function stepOf(name, input) {
  const value = [input.command, input.file_path, input.path, input.pattern, input.url, input.query].find(
    (item) => typeof item === "string",
  )
  return { tool: name, detail: value }
}
/** One JSON value per line; anything else is not for us */
function parseLine(line) {
  try {
    const value = JSON.parse(line)
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}
adapter({
  inspect: async (product) => ({
    name: "Claude Code",
    path: product.command,
    recommended: "2.1.283",
    upgrade: "claude update",
    ...(await version(product.command || "claude")),
  }),
  async run(task, host) {
    const child = spawn(task.product.command || "claude", claudeArgs({ ...task, extra: task.product.args }), {
      cwd: task.cwd,
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    })
    const exited = new Promise((resolve) => {
      child.once("exit", (code) => resolve(code ?? -1))
      child.once("error", () => resolve(-1))
    })
    const send = (message) => child.stdin.write(JSON.stringify(message) + "\n")
    task.signal.addEventListener("abort", () => void stop(child), { once: true })
    send({ type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: task.prompt } })
    try {
      const result = await follow(readline.createInterface({ input: child.stdout, crlfDelay: Infinity }), host, send)
      if (!result) throw new Error(`Claude Code ended without a reply (exit code ${await exited})`)
      return result
    } finally {
      // Its input stays open until the result, so pending permission requests are not cut off
      await stop(child)
    }
  },
})
/** Answers Claude Code's requests until its result; undefined when it ends without one */
async function follow(lines, host, send) {
  for await (const line of lines) {
    const message = parseLine(line)
    if (!message) continue
    if (message.type === "control_request" && message.request?.subtype === "can_use_tool") {
      const id = message.request_id
      void answer(host, message.request.tool_name ?? "", message.request.input ?? {}).then(
        (response) => send({ type: "control_response", response: { subtype: "success", request_id: id, response } }),
        (error) =>
          send({ type: "control_response", response: { subtype: "error", request_id: id, error: error.message } }),
      )
      continue
    }
    if (message.type === "assistant")
      for (const block of message.message?.content ?? [])
        if (block.type === "tool_use") host.step(stepOf(block.name ?? "", block.input ?? {}))
    if (message.type !== "result") continue
    if (message.subtype !== "success") throw new Error(String(message.result ?? message.subtype))
    return { text: String(message.result ?? "").trim(), sessionId: message.session_id }
  }
}
