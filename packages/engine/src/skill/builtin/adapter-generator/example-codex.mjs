// MerakCode's own adapter, generated from packages/engine/src/collaboration/adapters/codex.ts. Do not edit.
import readline from "node:readline"
import { adapter, connect, spawn, stop, version } from "./merakcode-adapter.mjs"
/** Thread settings for a mode: read-only keeps Codex's sandbox read-only; otherwise it writes the workspace */
function codexThread(input) {
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
export function unwrapShell(command) {
  // The shell: a quoted path (it may hold spaces) or a bare one, ending in a known shell's name
  const shell =
    /^\s*(?:"[^"]*[\\/]?(?:powershell|pwsh|bash|zsh|sh)(?:\.exe)?"|\S*(?:powershell|pwsh|bash|zsh|sh)(?:\.exe)?)/i
  const head = shell.exec(command)
  if (!head) return command
  const rest = /^\s+(?:-NoProfile\s+)?(?:-Command|-lc|-c)\s+(['"])([\s\S]*)\1\s*$/i.exec(command.slice(head[0].length))
  return rest ? rest[2] : command
}
function questionsOf(params) {
  return params.questions.map((item) => ({
    question: item.question,
    header: item.header,
    options: item.options ?? [],
  }))
}
adapter({
  inspect: async (product) => ({
    name: "Codex",
    path: product.command,
    recommended: "0.164.0",
    upgrade: "codex update",
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
/** One turn of Codex on a thread, new or resumed, answering its requests until the turn is completed */
function turn(child, task, host) {
  return new Promise((resolve, reject) => {
    // What each item is, seen when it starts: an approval request names only the item
    const items = new Map()
    let reply = ""
    const decision = async (allowed) => ({
      decision: (await allowed).allow ? "accept" : "decline",
    })
    const rpc = connect({
      lines: readline.createInterface({ input: child.stdout, crlfDelay: Infinity }),
      send: (line) => child.stdin.write(line + "\n"),
      handlers: {
        "item/started": (params) => {
          const item = params.item
          if (item.id) items.set(item.id, item)
          stepOf(host, item)
        },
        "item/completed": (params) => {
          if (params.item.type === "agentMessage" && params.item.text) reply = params.item.text
        },
        "item/commandExecution/requestApproval": (params) => {
          const command = unwrapShell(params.command ?? items.get(params.itemId)?.command ?? "")
          return decision(host.permission({ kind: "command", command }))
        },
        "item/fileChange/requestApproval": (params) => {
          const paths = (items.get(params.itemId)?.changes ?? []).flatMap((change) =>
            change.path ? [change.path] : [],
          )
          return decision(host.permission({ kind: "write", paths }))
        },
        "item/permissions/requestApproval": async (params) => {
          const verdict = await host.permission({ kind: "tool", name: "codex permissions", detail: params.reason })
          return { permissions: verdict.allow ? params.permissions : {} }
        },
        "item/tool/requestUserInput": async (params) => {
          const answers = await host.question(questionsOf(params))
          return {
            answers: Object.fromEntries(
              params.questions.map((item, index) => [item.id, { answers: answers[index] ?? [] }]),
            ),
          }
        },
        "turn/completed": (params) => {
          done = true
          if (params.turn.status === "completed") resolve({ text: reply.trim(), sessionId: thread })
          else reject(new Error(params.turn.error?.message ?? `The Codex turn ${params.turn.status}`))
        },
      },
    })
    let thread
    let done = false
    void (async () => {
      await rpc.request("initialize", { clientInfo: { name: "merakcode", title: "MerakCode", version: "1" } })
      rpc.notify("initialized")
      const settings = codexThread(task)
      const started = await rpc.request(
        task.resume ? "thread/resume" : "thread/start",
        task.resume ? { threadId: task.resume, ...settings } : settings,
      )
      thread = started.thread.id
      await rpc.request("turn/start", { threadId: thread, input: [{ type: "text", text: task.prompt }] })
    })().catch(reject)
    child.once("exit", (code) => !done && reject(new Error(`Codex ended without a reply (exit code ${code})`)))
    child.once("error", reject)
  })
}
function stepOf(host, item) {
  if (item.type === "commandExecution" && item.command)
    host.step({ tool: "command", detail: unwrapShell(item.command) })
  if (item.type === "fileChange")
    for (const change of item.changes ?? []) if (change.path) host.step({ tool: "edit", detail: change.path })
}
