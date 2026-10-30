// MerakCode's own adapter, generated from packages/engine/src/agent/external/adapters/codex.ts. Do not edit.
/**
 * Built-in member adapter for Codex. It runs `codex app-server` (JSON-RPC on stdio) with the untrusted approval
 * policy, so every command and file change Codex is unsure about comes to MerakCode first; request_user_input becomes
 * a MerakCode question. Commands still run in Codex's own sandbox. Written with the adapter library alone, the same
 * way anyone's adapter is.
 *
 * How one task goes (Codex talks JSON-RPC on stdin and stdout, so `connect` from the library does the messages):
 * 1. `run` starts `codex app-server`; `turn` sends `initialize`, then `thread/start` (or `thread/resume` with
 *    `task.resume`) with the settings from `codexThread`, then `turn/start` with the task.
 * 2. Codex then sends requests of its own, each answered by a handler in `turn`:
 *    - `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` become `host.permission`, and the
 *      verdict goes back as `accept` or `decline`;
 *    - `item/tool/requestUserInput` becomes `host.question`;
 *    - `item/started` says what Codex is doing, shown with `host.step`.
 * 3. `turn/completed` ends the task: the last agent message is the reply, the thread id continues it next time.
 * 4. Done, failed or stopped by the user (`task.signal`), `stop` ends Codex.
 */
import type { ChildProcess } from "node:child_process"
import readline from "node:readline"
import {
  adapter,
  connect,
  spawn,
  stop,
  version,
  type Host,
  type Mode,
  type Question,
  type Result,
  type Task,
  type Product,
  type ModelList,
} from "./merakcode-adapter.mjs"

/** Thread settings for a mode: read-only keeps Codex's sandbox read-only; otherwise it writes the workspace */
function codexThread(input: { mode: Mode; cwd: string }) {
  return {
    cwd: input.cwd,
    approvalPolicy: "untrusted",
    sandbox: input.mode === "readonly" ? "read-only" : "workspace-write",
    // Commands that need the network ask first: the approval request comes to MerakCode
    config: input.mode === "readonly" ? undefined : { sandbox_workspace_write: { network_access: true } },
  }
}

/**
 * The command a person would read: Codex runs each one through a shell (`powershell.exe -Command '…'` on Windows,
 * `bash -lc '…'` elsewhere), and MerakCode judges what is inside
 */
export function unwrapShell(command: string) {
  // The shell: a quoted path (it may hold spaces) or a bare one, ending in a known shell's name
  const shell =
    /^\s*(?:"[^"]*[\\/]?(?:powershell|pwsh|bash|zsh|sh)(?:\.exe)?"|\S*(?:powershell|pwsh|bash|zsh|sh)(?:\.exe)?)/i
  const head = shell.exec(command)
  if (!head) return command
  const rest = /^\s+(?:-NoProfile\s+)?(?:-Command|-lc|-c)\s+(['"])([\s\S]*)\1\s*$/i.exec(command.slice(head[0].length))
  return rest ? rest[2]! : command
}

type Item = { type?: string; id?: string; command?: string; text?: string; changes?: { path?: string }[] }
type QuestionParams = {
  questions: { id: string; header: string; question: string; options?: { label: string; description: string }[] }[]
}

function questionsOf(params: QuestionParams): Question[] {
  return params.questions.map((item) => ({
    question: item.question,
    header: item.header,
    options: item.options ?? [],
  }))
}

adapter({
  models: codexModels,
  inspect: async (product) => ({
    name: "Codex",
    path: product.command,
    recommended: "0.164.0",
    upgrade: "codex update",
    capabilities: {
      modelSelection: true,
      modelDiscovery: true,
      textStreaming: true,
      resume: true,
      permission: "merak",
      questions: true,
    },
    ...(await version(product.command || "codex")),
  }),
  async run(task, host) {
    const child = spawn(
      task.product.command || "codex",
      ["app-server", "--enable", "default_mode_request_user_input", ...(task.product.args ?? [])],
      { cwd: task.cwd, stdio: ["pipe", "pipe", "inherit"], windowsHide: true },
    )
    task.signal.addEventListener("abort", () => void stop(child), { once: true })
    try {
      return await turn(child, task, host)
    } finally {
      await stop(child)
    }
  },
})

async function codexModels(product: Product, signal: AbortSignal): Promise<ModelList> {
  const child = spawn(product.command || "codex", ["app-server", ...(product.args ?? [])], {
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  })
  const cancel = () => void stop(child)
  signal.addEventListener("abort", cancel, { once: true })
  const rpc = connect({
    lines: readline.createInterface({ input: child.stdout!, crlfDelay: Infinity }),
    send: (line) => child.stdin!.write(line + "\n"),
    handlers: {},
  })
  try {
    await rpc.request("initialize", { clientInfo: { name: "merakcode", title: "MerakCode", version: "1" } })
    rpc.notify("initialized")
    const models: ModelList["models"] = []
    let cursor: string | undefined
    do {
      const page = await rpc.request<{
        data: { id: string; model?: string; displayName?: string }[]
        nextCursor?: string | null
      }>("model/list", { cursor, limit: 100 })
      models.push(
        ...page.data.map((entry) => ({
          id: entry.model ?? entry.id,
          title: entry.displayName ?? entry.model ?? entry.id,
        })),
      )
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    return { models, allowCustomID: true }
  } finally {
    signal.removeEventListener("abort", cancel)
    await stop(child)
  }
}

/** One turn of Codex on a thread, new or resumed, answering its requests until the turn is completed */
function turn(child: ChildProcess, task: Task, host: Host) {
  return new Promise<Result>((resolve, reject) => {
    // What each item is, seen when it starts: an approval request names only the item
    const items = new Map<string, Item>()
    let reply = ""
    let final: Result["final"]
    let actualModel: Result["actualModel"]
    const decision = async (allowed: Promise<{ allow: boolean }>) => ({
      decision: (await allowed).allow ? "accept" : "decline",
    })
    const rpc = connect({
      lines: readline.createInterface({ input: child.stdout!, crlfDelay: Infinity }),
      send: (line) => child.stdin!.write(line + "\n"),
      handlers: {
        "item/agentMessage/delta": (params: { threadId: string; itemId: string; delta: string }) => {
          if (params.threadId !== thread || typeof params.delta !== "string") return
          host.textDelta({ messageID: params.itemId, partID: "text", delta: params.delta })
        },
        "item/started": (params: { item: Item }) => {
          const item = params.item
          if (item.id) items.set(item.id, item)
          stepOf(host, item)
        },
        "item/completed": (params: { item: Item }) => {
          if (params.item.type === "agentMessage" && params.item.text) {
            reply = params.item.text
            final = { messageID: params.item.id ?? "reply", parts: [{ partID: "text", text: reply }] }
          }
        },
        "item/commandExecution/requestApproval": (params: { itemId: string; command?: string }) => {
          const command = unwrapShell(params.command ?? items.get(params.itemId)?.command ?? "")
          return decision(host.permission({ kind: "command", command }))
        },
        "item/fileChange/requestApproval": (params: { itemId: string }) => {
          const paths = (items.get(params.itemId)?.changes ?? []).flatMap((change) =>
            change.path ? [change.path] : [],
          )
          return decision(host.permission({ kind: "write", paths }))
        },
        "item/permissions/requestApproval": async (params: { permissions: unknown; reason?: string }) => {
          const verdict = await host.permission({ kind: "tool", name: "codex permissions", detail: params.reason })
          return { permissions: verdict.allow ? params.permissions : {} }
        },
        "item/tool/requestUserInput": async (params: QuestionParams) => {
          const answers = await host.question(questionsOf(params))
          return {
            answers: Object.fromEntries(
              params.questions.map((item, index) => [item.id, { answers: answers[index] ?? [] }]),
            ),
          }
        },
        "turn/completed": (params: { turn: { status: string; error?: { message?: string } } }) => {
          done = true
          if (params.turn.status === "completed") resolve({ text: reply.trim(), sessionId: thread, actualModel, final })
          else reject(new Error(params.turn.error?.message ?? `The Codex turn ${params.turn.status}`))
        },
      },
    })
    let thread: string | undefined
    let done = false
    void (async () => {
      await rpc.request("initialize", { clientInfo: { name: "merakcode", title: "MerakCode", version: "1" } })
      rpc.notify("initialized")
      const settings = { ...codexThread(task), ...(task.model && { model: task.model.id }) }
      const started = await rpc.request<{ thread: { id: string; model?: string }; model?: string }>(
        task.resume ? "thread/resume" : "thread/start",
        task.resume ? { threadId: task.resume, ...settings } : settings,
      )
      thread = started.thread.id
      const model = started.model ?? started.thread.model
      if (model) actualModel = { id: model }
      await host.sessionStarted({ sessionId: thread })
      await rpc.request("turn/start", {
        threadId: thread,
        input: [{ type: "text", text: task.prompt }],
        ...(task.model && { model: task.model.id }),
      })
    })().catch(reject)
    child.once("exit", (code) => !done && reject(new Error(`Codex ended without a reply (exit code ${code})`)))
    child.once("error", reject)
  })
}

function stepOf(host: Host, item: Item) {
  if (item.type === "commandExecution" && item.command)
    host.step({ tool: "command", detail: unwrapShell(item.command) })
  if (item.type === "fileChange")
    for (const change of item.changes ?? []) if (change.path) host.step({ tool: "edit", detail: change.path })
}
