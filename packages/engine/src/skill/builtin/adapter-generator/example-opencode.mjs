// MerakCode's own adapter, generated from packages/engine/src/collaboration/adapters/opencode.ts. Do not edit.
/**
 * Built-in member adapter for OpenCode. It runs `opencode serve` on 127.0.0.1 with a random password and drives one
 * session over HTTP: what OpenCode would decide itself is set to ask, only for this run, so each request comes to
 * MerakCode; its question tool becomes a MerakCode question. Written with the adapter library alone, the same way
 * anyone's adapter is.
 */
import { randomBytes } from "node:crypto"
import readline from "node:readline"
import { adapter, spawn, stop, version } from "./merakcode-adapter.mjs"
/**
 * Permissions for one run, given in OPENCODE_CONFIG_CONTENT: it only overrides the permission section, and the user's
 * own config and files are left as they are
 */
function opencodeConfig(mode) {
  return {
    permission: {
      edit: mode === "readonly" ? "deny" : "ask",
      bash: "ask",
      webfetch: "ask",
      websearch: "ask",
      read: "ask",
      external_directory: "ask",
    },
  }
}
/** What MerakCode is asked for an OpenCode permission request */
function opencodeRequest(asked) {
  const meta = asked.metadata ?? {}
  const text = (key) => (typeof meta[key] === "string" ? meta[key] : undefined)
  const patterns = asked.patterns ?? []
  if (asked.permission === "edit") return { kind: "write", paths: [text("filepath") ?? patterns[0] ?? ""] }
  if (asked.permission === "read" || asked.permission === "external_directory")
    return { kind: "read", paths: [text("filepath") ?? patterns[0] ?? ""] }
  if (asked.permission === "bash") return { kind: "command", command: text("command") ?? patterns[0] ?? "" }
  if (asked.permission === "webfetch" || asked.permission === "websearch") {
    const url = text("url") ?? patterns[0] ?? ""
    return { kind: "network", host: URL.canParse(url) ? new URL(url).hostname : url, url }
  }
  return { kind: "tool", name: asked.permission, detail: patterns[0] }
}
function questionsOf(asked) {
  return asked.questions.map((item) => ({
    question: item.question,
    header: item.header,
    options: item.options ?? [],
    multiple: item.multiple,
  }))
}
adapter({
  inspect: async (product) => ({
    name: "OpenCode",
    path: product.command,
    recommended: "1.19.4",
    upgrade: "opencode upgrade",
    ...(await version(product.command || "opencode")),
  }),
  async run(task, host) {
    const password = randomBytes(16).toString("hex")
    const child = spawn(
      task.product.command || "opencode",
      ["serve", "--hostname", "127.0.0.1", "--port", "0", ...(task.product.args ?? [])],
      {
        cwd: task.cwd,
        stdio: ["ignore", "pipe", "inherit"],
        windowsHide: true,
        env: {
          ...process.env,
          OPENCODE_SERVER_PASSWORD: password,
          OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig(task.mode)),
        },
      },
    )
    task.signal.addEventListener("abort", () => void stop(child), { once: true })
    try {
      const base = await listening(child.stdout)
      const headers = {
        authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64"),
        "content-type": "application/json",
      }
      const query = `directory=${encodeURIComponent(task.cwd)}`
      const call = async (method, path, body) => {
        const response = await fetch(`${base}${path}${path.includes("?") ? "&" : "?"}${query}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: task.signal,
        })
        if (!response.ok) throw new Error(`OpenCode ${method} ${path}: ${response.status}`)
        return response.status === 204 ? undefined : response.json()
      }
      const events = await fetch(`${base}/event?${query}`, { headers, signal: task.signal })
      const session = task.resume ?? (await call("POST", "/session", { title: "MerakCode" })).id
      await call("POST", `/session/${session}/prompt_async`, { parts: [{ type: "text", text: task.prompt }] })
      await follow(events, session, host, call)
      const messages = await call("GET", `/session/${session}/message`)
      const last = messages.findLast((message) => message.info.role === "assistant")
      const text = (last?.parts ?? [])
        .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
        .join("\n")
      return { text: text.trim(), sessionId: session }
    } finally {
      // The server does not end on its own
      await stop(child)
    }
  },
})
/** The server's address, from the line it prints once it listens; its later output is read on and dropped */
function listening(stdout) {
  return new Promise((resolve, reject) => {
    const lines = readline.createInterface({ input: stdout, crlfDelay: Infinity })
    lines.on("line", (line) => {
      const url = /https?:\/\/[\d.]+:\d+/.exec(line)?.[0]
      if (url) resolve(url)
    })
    lines.once("close", () => reject(new Error("OpenCode exited before it started its server")))
  })
}
/** The lines of the server's event stream as they arrive */
async function* eventLines(body) {
  if (!body) return
  const decoder = new TextDecoder()
  let text = ""
  for await (const chunk of body) {
    text += decoder.decode(chunk, { stream: true })
    const parts = text.split(/\r?\n/)
    text = parts.pop() ?? ""
    yield* parts
  }
}
/** Answers the session's requests from the event stream until the session is idle again */
async function follow(events, session, host, call) {
  let busy = false
  // A running tool part is updated again as it goes; it is one step
  const stepped = new Set()
  for await (const line of eventLines(events.body)) {
    if (!line.startsWith("data:")) continue
    const event = JSON.parse(line.slice(5))
    const properties = event.properties
    if (properties.sessionID !== undefined && properties.sessionID !== session) continue
    if (event.type === "permission.asked") {
      const asked = properties
      void host
        .permission(opencodeRequest(asked))
        .then((verdict) =>
          call(
            "POST",
            `/permission/${asked.id}/reply`,
            verdict.allow ? { reply: "once" } : { reply: "reject", message: verdict.message },
          ),
        )
        // An answer that cannot reach a server being stopped no longer matters
        .catch(() => {})
    }
    if (event.type === "question.asked") {
      const asked = properties
      void host
        .question(questionsOf(asked))
        .then((answers) => call("POST", `/question/${asked.id}/reply`, { answers }))
        .catch(() => {})
    }
    if (event.type === "message.part.updated") {
      const part = properties.part
      const fresh = !part.id || !stepped.has(part.id)
      if (part.sessionID === session && part.type === "tool" && part.state?.status === "running" && fresh) {
        if (part.id) stepped.add(part.id)
        const input = part.state.input ?? {}
        const value = [input.command, input.filePath, input.filepath, input.url, input.pattern].find(
          (item) => typeof item === "string",
        )
        host.step({ tool: part.tool ?? "tool", detail: value })
      }
    }
    if (event.type === "session.status") {
      if (properties.status?.type === "busy") busy = true
      if (properties.status?.type === "idle" && busy) return
    }
  }
  throw new Error("OpenCode closed its event stream before the task was done")
}
