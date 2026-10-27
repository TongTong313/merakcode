// A stand-in for `opencode serve` as OpenCode 1.19 runs it: it prints where it listens, checks the password, and on a
// prompt asks for each item in OPENCODE_FIXTURE (a JSON list) over its event stream, then answers with a message
// naming each reply. It records its arguments, its config and the requests it got.
import fs from "node:fs"
import http from "node:http"

// Like the real CLI it prints its version
if (process.argv[2] === "--version") {
  console.log("1.19.4")
  process.exit(0)
}

type Item =
  | { permission: string; patterns: string[]; metadata?: Record<string, unknown> }
  | { question: string; options: string[] }

const record = process.env.OPENCODE_FIXTURE_ARGS
// Its process id, so a test can see whether it was left running
if (process.env.OPENCODE_FIXTURE_PID) fs.writeFileSync(process.env.OPENCODE_FIXTURE_PID, String(process.pid))
const items = JSON.parse(process.env.OPENCODE_FIXTURE ?? "[]") as Item[]
const seen: Record<string, unknown> = {
  argv: process.argv.slice(2),
  config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}"),
  prompts: [] as unknown[],
}
const save = () => record && fs.writeFileSync(record, JSON.stringify(seen))
save()

const auth = "Basic " + Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")
const streams = new Set<http.ServerResponse>()
const emit = (type: string, properties: unknown) => {
  for (const stream of streams) stream.write(`data: ${JSON.stringify({ type, properties })}\n\n`)
}
const waiting = new Map<string, (body: Record<string, unknown>) => void>()
const sessions = new Map<string, { text: string; model?: { providerID: string; modelID: string } }>()
let next = 0

const body = (request: http.IncomingMessage) =>
  new Promise<Record<string, unknown>>((resolve) => {
    let text = ""
    request.on("data", (chunk) => (text += chunk))
    request.on("end", () => resolve(text ? JSON.parse(text) : {}))
  })

async function work(sessionID: string, prompt: string) {
  emit("session.status", { sessionID, status: { type: "busy" } })
  if (process.env.OPENCODE_FIXTURE_STREAM) {
    emit("message.updated", { info: { id: "reply", sessionID, role: "assistant" } })
    for (const delta of ["Hello ", "world"])
      emit("message.part.delta", { sessionID, messageID: "reply", partID: "text", field: "text", delta })
    sessions.get(sessionID)!.text = "Hello world"
    emit("session.status", { sessionID, status: { type: "idle" } })
    return
  }
  const replies: string[] = []
  for (const item of items) {
    const id = `req_${++next}`
    const answered = new Promise<Record<string, unknown>>((resolve) => waiting.set(id, resolve))
    if ("permission" in item) {
      // OpenCode updates a running tool part more than once, as its output grows
      for (let update = 0; update < 2; update++)
        emit("message.part.updated", {
          part: {
            id: `part_${id}`,
            sessionID,
            type: "tool",
            tool: item.permission,
            state: { status: "running", input: item.metadata ?? {} },
          },
        })
      emit("permission.asked", {
        id,
        sessionID,
        permission: item.permission,
        patterns: item.patterns,
        metadata: item.metadata ?? {},
        always: [],
      })
      replies.push(`${item.permission} ${(await answered).reply}`)
      continue
    }
    emit("question.asked", {
      id,
      sessionID,
      questions: [
        { question: item.question, header: "选择", options: item.options.map((label) => ({ label, description: "" })) },
      ],
    })
    replies.push(`answer ${JSON.stringify((await answered).answers)}`)
  }
  sessions.get(sessionID)!.text = [`prompt: ${prompt}`, ...replies].join("\n")
  emit("session.status", { sessionID, status: { type: "idle" } })
}

const server = http.createServer(async (request, response) => {
  if (request.headers.authorization !== auth) return void response.writeHead(401).end()
  const url = new URL(request.url ?? "/", "http://localhost")
  const json = (value: unknown) =>
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value))
  if (url.pathname === "/provider")
    return json({ all: [{ id: "fixture-provider", models: { "fixture-model": { name: "Fixture model" } } }] })
  if (url.pathname === "/event") {
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`)
    streams.add(response)
    return
  }
  if (request.method === "POST" && url.pathname === "/session") {
    const id = "ses_fixture_1"
    sessions.set(id, { text: "" })
    return json({ id })
  }
  const prompt = /^\/session\/([^/]+)\/prompt_async$/.exec(url.pathname)
  if (request.method === "POST" && prompt) {
    const sessionID = prompt[1]!
    sessions.set(sessionID, sessions.get(sessionID) ?? { text: "" })
    const input = await body(request)
    sessions.get(sessionID)!.model = input.model as { providerID: string; modelID: string } | undefined
    ;(seen.prompts as unknown[]).push({ sessionID, ...input })
    save()
    response.writeHead(204).end()
    void work(sessionID, (input.parts as { text: string }[])[0]!.text)
    return
  }
  const messages = /^\/session\/([^/]+)\/message$/.exec(url.pathname)
  if (messages)
    return json([
      { info: { role: "user" }, parts: [] },
      {
        info: { id: "reply", role: "assistant", ...sessions.get(messages[1]!)?.model },
        parts: [{ id: "text", type: "text", text: sessions.get(messages[1]!)?.text ?? "" }],
      },
    ])
  const reply = /^\/(permission|question)\/([^/]+)\/reply$/.exec(url.pathname)
  if (request.method === "POST" && reply) {
    waiting.get(reply[2]!)?.(await body(request))
    return json(true)
  }
  response.writeHead(404).end()
})

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address() as { port: number }
  console.log(`opencode server listening on http://127.0.0.1:${port}`)
})
