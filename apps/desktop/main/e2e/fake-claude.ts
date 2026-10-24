// A stand-in for `claude -p` with the stream-json control protocol, as Claude Code 2.1 speaks it: it reads the user
// message on stdin, asks to use each tool listed in the JSON file CLAUDE_FIXTURE_FILE names ({ name, input }), reports
// a tool_use step for each, and ends with a result naming each verdict.
import fs from "node:fs"
import readline from "node:readline"

// Like the real CLI it prints its version
if (process.argv[2] === "--version") {
  console.log("2.1.283 (Claude Code)")
  process.exit(0)
}

const tools = JSON.parse(fs.readFileSync(process.env.CLAUDE_FIXTURE_FILE!, "utf8")) as {
  name: string
  input: Record<string, unknown>
}[]
const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + "\n")
const waiting = new Map<string, (response: { behavior: string; message?: string; updatedInput?: unknown }) => void>()
const session = "claude-session-1"
let asked = 0

async function work(prompt: string) {
  send({ type: "system", subtype: "init", session_id: session })
  const verdicts: string[] = []
  for (const tool of tools) {
    const id = `req_${++asked}`
    const response = await new Promise<{ behavior: string; message?: string; updatedInput?: unknown }>((resolve) => {
      waiting.set(id, resolve)
      send({
        type: "control_request",
        request_id: id,
        request: { subtype: "can_use_tool", tool_name: tool.name, input: tool.input, tool_use_id: `toolu_${asked}` },
      })
    })
    send({
      type: "assistant",
      session_id: session,
      message: { content: [{ type: "tool_use", id: `toolu_${asked}`, name: tool.name, input: tool.input }] },
    })
    verdicts.push(
      response.behavior === "allow"
        ? `${tool.name} allowed${response.updatedInput ? " " + JSON.stringify(response.updatedInput) : ""}`
        : `${tool.name} denied: ${response.message}`,
    )
  }
  send({
    type: "result",
    subtype: "success",
    session_id: session,
    result: [`prompt: ${prompt}`, ...verdicts].join("\n"),
  })
}

for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line)
  if (message.type === "control_response") waiting.get(message.response.request_id)?.(message.response.response)
  if (message.type === "user") void work(message.message.content)
}
