// MerakCode's own adapter, generated from packages/engine/src/agent/external/adapters/opencode.ts. Do not edit.
/**
 * Built-in member adapter for OpenCode. It runs `opencode serve` on 127.0.0.1 with a random password and drives one
 * session over HTTP: what OpenCode would decide itself is set to ask, only for this run, so each request comes to
 * MerakCode; its question tool becomes a MerakCode question. Written with the adapter library alone, the same way
 * anyone's adapter is.
 *
 * How one task goes (OpenCode is a local HTTP server, with an event stream for what happens):
 * 1. `run` starts `opencode serve` on a free port with a password made for this run, and `listening` reads the
 *    address it prints. Every request carries the password.
 * 2. It opens the event stream (`GET /event`), then creates a session (or continues `task.resume`) and sends the task
 *    (`POST /session/<id>/prompt_async`).
 * 3. `follow` reads the event stream:
 *    - `permission.asked` becomes `host.permission`; the verdict goes back with `POST /permission/<id>/reply`;
 *    - `question.asked` becomes `host.question`; the answers go back with `POST /question/<id>/reply`;
 *    - a running tool part is shown with `host.step`;
 *    - the session going idle again ends the task.
 * 4. The reply is the text of the last assistant message; the session id continues it next time.
 * 5. Done, failed or stopped by the user (`task.signal`), `stop` ends the server: it would not end on its own.
 */
import { randomBytes } from "node:crypto"
import readline from "node:readline"
import type { Readable } from "node:stream"
import {
  adapter,
  spawn,
  stop,
  version,
  type Host,
  type Mode,
  type Permission,
  type Question,
  type Product,
  type ModelList,
} from "./merakcode-adapter.mjs"

/**
 * Permissions for one run, given in OPENCODE_CONFIG_CONTENT: it only overrides the permission section, and the user's
 * own config and files are left as they are
 */
function opencodeConfig(mode: Mode) {
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

type Asked = {
  id: string
  sessionID: string
  permission: string
  patterns?: string[]
  metadata?: Record<string, unknown>
}
type AskedQuestion = {
  id: string
  sessionID: string
  questions: {
    question: string
    header: string
    options?: { label: string; description: string }[]
    multiple?: boolean
  }[]
}

/** What MerakCode is asked for an OpenCode permission request */
function opencodeRequest(asked: Asked): Permission {
  const meta = asked.metadata ?? {}
  const text = (key: string) => (typeof meta[key] === "string" ? (meta[key] as string) : undefined)
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

function questionsOf(asked: AskedQuestion): Question[] {
  return asked.questions.map((item) => ({
    question: item.question,
    header: item.header,
    options: item.options ?? [],
    multiple: item.multiple,
  }))
}

adapter({
  models: opencodeModels,
  inspect: async (product) => ({
    name: "OpenCode",
    path: product.command,
    recommended: "1.19.4",
    upgrade: "opencode upgrade",
    capabilities: {
      modelSelection: true,
      modelDiscovery: true,
      textStreaming: true,
      resume: true,
      permission: "merak",
      questions: true,
    },
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
      const call = async (method: string, path: string, body?: unknown) => {
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
      const session = task.resume ?? ((await call("POST", "/session", { title: "MerakCode" })) as { id: string }).id
      await host.sessionStarted({ sessionId: session })
      await call("POST", `/session/${session}/prompt_async`, {
        parts: [{ type: "text", text: task.prompt }],
        ...(task.model && { model: { providerID: task.model.providerID, modelID: task.model.id } }),
      })
      await follow(events, session, host, call)
      const messages = (await call("GET", `/session/${session}/message`)) as {
        info: {
          id?: string
          role: string
          modelID?: string
          providerID?: string
          error?: { data?: { message?: string }; message?: string }
        }
        parts: { id?: string; type: string; text?: string }[]
      }[]
      const last = messages.findLast((message) => message.info.role === "assistant")
      if (last?.info.error)
        throw new Error(last.info.error.data?.message ?? last.info.error.message ?? "OpenCode failed")
      const text = (last?.parts ?? [])
        .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
        .join("\n")
      return {
        text: text.trim(),
        sessionId: session,
        actualModel: last?.info.modelID ? { id: last.info.modelID, providerID: last.info.providerID } : undefined,
        final: last
          ? {
              messageID: last.info.id ?? "reply",
              parts: last.parts.flatMap((part, index) =>
                part.type === "text" && typeof part.text === "string"
                  ? [{ partID: part.id ?? String(index), text: part.text }]
                  : [],
              ),
            }
          : undefined,
      }
    } finally {
      // The server does not end on its own
      await stop(child)
    }
  },
})

async function opencodeModels(product: Product, signal: AbortSignal): Promise<ModelList> {
  const password = randomBytes(16).toString("hex")
  const child = spawn(
    product.command || "opencode",
    ["serve", "--hostname", "127.0.0.1", "--port", "0", ...(product.args ?? [])],
    {
      stdio: ["ignore", "pipe", "inherit"],
      windowsHide: true,
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig("readonly")),
      },
    },
  )
  const cancel = () => void stop(child)
  signal.addEventListener("abort", cancel, { once: true })
  try {
    const base = await listening(child.stdout)
    const response = await fetch(`${base}/provider?directory=${encodeURIComponent(process.cwd())}`, {
      headers: { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") },
      signal,
    })
    if (!response.ok) throw new Error(`OpenCode model discovery: ${response.status}`)
    const catalog = (await response.json()) as { all: { id: string; models: Record<string, { name?: string }> }[] }
    return {
      models: catalog.all.flatMap((provider) =>
        Object.entries(provider.models).map(([id, model]) => ({
          id,
          providerID: provider.id,
          title: model.name ?? id,
        })),
      ),
      allowCustomID: true,
    }
  } finally {
    signal.removeEventListener("abort", cancel)
    await stop(child)
  }
}

/** The server's address, from the line it prints once it listens; its later output is read on and dropped */
function listening(stdout: Readable) {
  return new Promise<string>((resolve, reject) => {
    const lines = readline.createInterface({ input: stdout, crlfDelay: Infinity })
    lines.on("line", (line) => {
      const url = /https?:\/\/[\d.]+:\d+/.exec(line)?.[0]
      if (url) resolve(url)
    })
    lines.once("close", () => reject(new Error("OpenCode exited before it started its server")))
  })
}

/** The lines of the server's event stream as they arrive */
async function* eventLines(body: ReadableStream<Uint8Array> | null) {
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
async function follow(
  events: Response,
  session: string,
  host: Host,
  call: (method: string, path: string, body?: unknown) => Promise<unknown>,
) {
  let busy = false
  // A running tool part is updated again as it goes; it is one step
  const stepped = new Set<string>()
  const assistants = new Set<string>()
  for await (const line of eventLines(events.body)) {
    if (!line.startsWith("data:")) continue
    const event = JSON.parse(line.slice(5)) as { type: string; properties: Record<string, any> }
    const properties = event.properties
    if (properties.sessionID !== undefined && properties.sessionID !== session) continue
    if (
      event.type === "message.updated" &&
      properties.info?.sessionID === session &&
      properties.info?.role === "assistant"
    )
      assistants.add(properties.info.id)
    if (
      event.type === "message.part.delta" &&
      properties.sessionID === session &&
      properties.field === "text" &&
      assistants.has(properties.messageID) &&
      typeof properties.delta === "string"
    )
      host.textDelta({ messageID: properties.messageID, partID: properties.partID, delta: properties.delta })
    if (event.type === "permission.asked") {
      const asked = properties as Asked
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
      const asked = properties as AskedQuestion
      void host
        .question(questionsOf(asked))
        .then((answers) => call("POST", `/question/${asked.id}/reply`, { answers }))
        .catch(() => {})
    }
    if (event.type === "message.part.updated") {
      const part = properties.part as {
        id?: string
        sessionID?: string
        type?: string
        tool?: string
        state?: { status?: string; input?: Record<string, unknown> }
      }
      const fresh = !part.id || !stepped.has(part.id)
      if (part.sessionID === session && part.type === "tool" && part.state?.status === "running" && fresh) {
        if (part.id) stepped.add(part.id)
        const input = part.state.input ?? {}
        const value = [input.command, input.filePath, input.filepath, input.url, input.pattern].find(
          (item): item is string => typeof item === "string",
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
