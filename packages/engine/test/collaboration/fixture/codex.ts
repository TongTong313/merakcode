// A stand-in for `codex app-server`, speaking JSON-RPC on stdio as Codex 0.164 does: it records its arguments and the
// thread parameters, and for each item in CODEX_FIXTURE (a JSON list) asks the client what Codex would ask, then ends
// the turn with an agent message naming each answer.
import fs from "node:fs"
import readline from "node:readline"

// Like the real CLI it prints its version
if (process.argv[2] === "--version") {
  console.log("codex-cli 0.164.0")
  process.exit(0)
}

type Item =
  | { type: "command"; command: string }
  | { type: "fileChange"; paths: string[] }
  | { type: "question"; question: string; options: string[] }

const record = process.env.CODEX_FIXTURE_ARGS
const items = JSON.parse(process.env.CODEX_FIXTURE ?? "[]") as Item[]
const write = (message: unknown) => process.stdout.write(JSON.stringify(message) + "\n")
const waiting = new Map<number, (result: Record<string, unknown>) => void>()
let next = 1000
const ask = (method: string, params: unknown) =>
  new Promise<Record<string, unknown>>((resolve) => {
    const id = next++
    waiting.set(id, resolve)
    write({ id, method, params })
  })
const seen: Record<string, unknown> = { argv: process.argv.slice(2) }
const save = () => record && fs.writeFileSync(record, JSON.stringify(seen))
save()

async function turn(threadId: string, turnId: string, prompt: string) {
  if (process.env.CODEX_FIXTURE_STREAM) {
    for (const delta of ["Hello ", "world"])
      write({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "reply", delta } })
    write({
      method: "item/completed",
      params: { threadId, turnId, item: { type: "agentMessage", id: "reply", text: "Hello world" } },
    })
    write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } })
    return
  }
  const answers: string[] = []
  for (const [index, item] of items.entries()) {
    const itemId = `item_${index}`
    if (item.type === "command") {
      write({
        method: "item/started",
        params: { threadId, turnId, item: { type: "commandExecution", id: itemId, command: item.command, cwd: "." } },
      })
      const result = await ask("item/commandExecution/requestApproval", {
        threadId,
        turnId,
        itemId,
        command: item.command,
        startedAtMs: 0,
      })
      answers.push(`command ${result.decision}`)
    }
    if (item.type === "fileChange") {
      const changes = item.paths.map((path) => ({ path, kind: { type: "update" }, diff: "" }))
      write({
        method: "item/started",
        params: { threadId, turnId, item: { type: "fileChange", id: itemId, changes, status: "inProgress" } },
      })
      const result = await ask("item/fileChange/requestApproval", { threadId, turnId, itemId, startedAtMs: 0 })
      answers.push(`fileChange ${result.decision}`)
    }
    if (item.type === "question") {
      const result = await ask("item/tool/requestUserInput", {
        threadId,
        turnId,
        itemId,
        isBlocking: true,
        questions: [
          {
            id: "q1",
            header: "选择",
            question: item.question,
            options: item.options.map((label) => ({ label, description: "" })),
          },
        ],
      })
      answers.push(`answer ${JSON.stringify(result.answers)}`)
    }
  }
  write({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      item: { type: "agentMessage", id: "msg", text: [`prompt: ${prompt}`, ...answers].join("\n") },
    },
  })
  write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } })
}

for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line)
  if (message.method === undefined && waiting.has(message.id)) {
    waiting.get(message.id)!(message.result)
    waiting.delete(message.id)
    continue
  }
  if (message.method === "initialize") write({ id: message.id, result: { userAgent: "codex-fixture/0.164.0" } })
  if (message.method === "model/list")
    write({
      id: message.id,
      result: { data: [{ id: "display-id", model: "fixture-model", displayName: "Fixture model" }], nextCursor: null },
    })
  if (message.method === "thread/start" || message.method === "thread/resume") {
    seen[message.method] = message.params
    save()
    const id = message.method === "thread/resume" ? message.params.threadId : "codex-thread-1"
    write({ id: message.id, result: { thread: { id }, model: message.params.model ?? "fixture-default" } })
  }
  if (message.method === "turn/start") {
    seen["turn/start"] = message.params
    save()
    write({ id: message.id, result: { turn: { id: "turn_1", status: "inProgress", items: [] } } })
    void turn(message.params.threadId, "turn_1", message.params.input[0].text)
  }
}
