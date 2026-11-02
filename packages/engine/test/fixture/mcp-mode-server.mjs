import readline from "node:readline"
import fs from "node:fs"
import path from "node:path"

const directory = process.argv[2]
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n")
let timer
let callID
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line)
  if (request.method === "initialize")
    return send(request.id, {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "mode-fixture", version: "1" },
    })
  if (request.method === "tools/list")
    return send(request.id, { tools: [{ name: "mutate", inputSchema: { type: "object", properties: {} } }] })
  if (request.method === "tools/call") {
    callID = request.id
    fs.writeFileSync(path.join(directory, "started"), "ready")
    timer = setInterval(() => {
      if (!fs.existsSync(path.join(directory, "release"))) return
      clearInterval(timer)
      fs.writeFileSync(path.join(directory, "effect"), "written")
      send(callID, { content: [{ type: "text", text: "done" }] })
    }, 10)
  }
  if (request.method === "notifications/cancelled") {
    clearInterval(timer)
    fs.writeFileSync(path.join(directory, "cancelled"), "cancelled")
  }
})
