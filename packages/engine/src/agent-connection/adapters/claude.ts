/**
 * Built-in member adapter for Claude Code. It runs `claude -p` with stream-json in and out and the stdio permission
 * host, so every tool Claude Code would ask about comes to MerakCode first; AskUserQuestion becomes a MerakCode
 * question. Written with the adapter library alone, the same way anyone's adapter is.
 *
 * How one task goes (Claude Code talks in JSON lines on stdin and stdout):
 * 1. `run` starts `claude -p` with the arguments from `claudeArgs` and writes the task as one JSON line to its stdin.
 * 2. `follow` reads Claude Code's output line by line:
 *    - a `control_request` of subtype `can_use_tool` is Claude Code asking before it uses a tool. `answer` turns it into
 *      `host.permission` (or `host.question` for its AskUserQuestion tool) and the verdict goes back as a
 *      `control_response` line with the same `request_id`;
 *    - an `assistant` line with `tool_use` blocks says which tools it uses, shown with `host.step`;
 *    - the `result` line ends the task: its text is the reply, its `session_id` continues the session next time.
 * 3. Done, failed or stopped by the user (`task.signal`), `stop` ends Claude Code.
 */
import readline from "node:readline"
import {
  adapter,
  spawn,
  stop,
  version,
  type Host,
  type Mode,
  type Permission,
  type Question,
  type Result,
  type ProductModel,
} from "@merakcode/sdk/adapter"

/** Edits are not offered at all in read-only mode, so Claude Code does not try them */
const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"]

/** Arguments for one task; they are given again on resume, since Claude Code keeps none of them */
function claudeArgs(input: { mode: Mode; resume?: string; extra?: string[]; model?: ProductModel }) {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-prompt-tool",
    "stdio",
    // Everything Claude Code is unsure about goes to MerakCode, which applies the group's mode
    "--permission-mode",
    "manual",
    ...(input.mode === "readonly" ? ["--disallowedTools", ...EDIT_TOOLS] : []),
    ...(input.resume ? ["--resume", input.resume] : []),
    ...(input.model ? ["--model", input.model.id] : []),
    ...(input.extra ?? []),
  ]
}

type ToolInput = Record<string, unknown>
/** The lines of Claude Code's stream-json output that matter here */
type Message = {
  type?: string
  subtype?: string
  is_error?: boolean
  terminal_reason?: string
  parent_tool_use_id?: string | null
  model?: string
  event?: {
    type?: string
    message?: { id?: string; model?: string }
    index?: number
    delta?: { type?: string; text?: string }
  }
  request_id?: string
  request?: { subtype?: string; tool_name?: string; input?: ToolInput }
  message?: {
    id?: string
    model?: string
    content?: { type?: string; text?: string; name?: string; input?: ToolInput }[]
  }
  result?: string
  session_id?: string
}
type Response = { behavior: "allow"; updatedInput: ToolInput } | { behavior: "deny"; message: string }

/** What MerakCode is asked for a tool Claude Code wants to use */
function claudeRequest(name: string, input: ToolInput): Permission {
  const text = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "")
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
function questionsOf(input: ToolInput): Question[] {
  const list = Array.isArray(input.questions) ? (input.questions as Record<string, unknown>[]) : []
  return list.map((item) => ({
    question: String(item.question ?? ""),
    header: String(item.header ?? ""),
    options: Array.isArray(item.options)
      ? (item.options as { label?: string; description?: string }[]).map((option) => ({
          label: String(option.label ?? ""),
          description: String(option.description ?? ""),
        }))
      : [],
    multiple: item.multiSelect === true,
  }))
}

/** MerakCode's decision as Claude Code's permission response */
async function answer(host: Host, name: string, input: ToolInput): Promise<Response> {
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
function stepOf(name: string, input: ToolInput) {
  const value = [input.command, input.file_path, input.path, input.pattern, input.url, input.query].find(
    (item): item is string => typeof item === "string",
  )
  return { tool: name, detail: value }
}

/** One JSON value per line; anything else is not for us */
function parseLine(line: string): Message | undefined {
  try {
    const value = JSON.parse(line)
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

adapter({
  models: () => ({ models: ["sonnet", "opus", "haiku"].map((id) => ({ id, title: id })), allowCustomID: true }),
  inspect: async (product) => ({
    name: "Claude Code",
    path: product.command,
    recommended: "2.1.283",
    upgrade: "claude update",
    capabilities: {
      modelSelection: true,
      modelDiscovery: true,
      textStreaming: true,
      resume: true,
      permission: "merak",
      questions: true,
    },
    ...(await version(product.command || "claude")),
  }),
  async run(task, host) {
    const child = spawn(task.product.command || "claude", claudeArgs({ ...task, extra: task.product.args }), {
      cwd: task.cwd,
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    })
    const exited = new Promise<number>((resolve) => {
      child.once("exit", (code) => resolve(code ?? -1))
      child.once("error", () => resolve(-1))
    })
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + "\n")
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
async function follow(
  lines: AsyncIterable<string>,
  host: Host,
  send: (message: unknown) => void,
): Promise<Result | undefined> {
  let sessionID: string | undefined
  let messageID = "reply"
  let actualModel: ProductModel | undefined
  let final: Result["final"]
  for await (const line of lines) {
    const message = parseLine(line)
    if (!message) continue
    if (message.parent_tool_use_id) continue
    if (message.session_id && message.session_id !== sessionID) {
      sessionID = message.session_id
      await host.sessionStarted({ sessionId: sessionID })
    }
    if (message.model) actualModel = { id: message.model }
    if (message.type === "stream_event") {
      const event = message.event
      if (event?.type === "message_start") {
        messageID = event.message?.id ?? messageID
        if (event.message?.model) actualModel = { id: event.message.model }
      }
      if (
        event?.type === "content_block_delta" &&
        event.delta?.type === "text_delta" &&
        typeof event.delta.text === "string"
      )
        host.textDelta({ messageID, partID: String(event.index ?? 0), delta: event.delta.text })
    }
    if (message.type === "control_request" && message.request?.subtype === "can_use_tool") {
      const id = message.request_id
      void answer(host, message.request.tool_name ?? "", message.request.input ?? {}).then(
        (response) => send({ type: "control_response", response: { subtype: "success", request_id: id, response } }),
        (error: Error) =>
          send({ type: "control_response", response: { subtype: "error", request_id: id, error: error.message } }),
      )
      continue
    }
    if (message.type === "assistant") {
      if (message.message?.model) actualModel = { id: message.message.model }
      const parts = (message.message?.content ?? []).flatMap((block, index) =>
        block.type === "text" && typeof block.text === "string" ? [{ partID: String(index), text: block.text }] : [],
      )
      if (parts.length) final = { messageID: message.message?.id ?? messageID, parts }
      for (const block of message.message?.content ?? [])
        if (block.type === "tool_use") host.step(stepOf(block.name ?? "", block.input ?? {}))
    }
    if (message.type !== "result") continue
    if (
      message.subtype !== "success" ||
      message.is_error ||
      ["api_error", "error", "cancelled"].includes(message.terminal_reason ?? "")
    )
      throw new Error(String(message.result ?? message.terminal_reason ?? message.subtype))
    return { text: String(message.result ?? "").trim(), sessionId: message.session_id, actualModel, final }
  }
}
