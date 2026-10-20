import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { appendFileSync } from "node:fs"
import { join } from "node:path"
const root = process.argv[2]
if (!root || !process.env.MERAKCODE_TEST_HOME?.startsWith(root)) throw new Error("isolated command fixture required")
const record = (method: string) =>
  appendFileSync(join(root, "command-mcp.jsonl"), JSON.stringify({ method, pid: process.pid }) + "\n")
record("start")
process.on("exit", () => record("exit"))
const server = new Server({ name: "command-failure", version: "1" }, { capabilities: { tools: {}, prompts: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  record("list")
  return { prompts: [{ name: "broken", description: "Controlled command template failure" }] }
})
server.setRequestHandler(GetPromptRequestSchema, async () => {
  record("get-failed")
  throw new Error("S04_TEMPLATE_FAILED")
})
await server.connect(new StdioServerTransport())
