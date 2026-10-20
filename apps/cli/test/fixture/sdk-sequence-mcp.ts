import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { Filesystem } from "@merakcode/util/filesystem"

const root = process.argv[2]
const name = process.argv[3] ?? "sequence"
if (!root || !process.env.MERAKCODE_TEST_HOME?.startsWith(root)) throw new Error("isolated MCP root required")
const record = (method: string, key?: unknown, argument?: string) =>
  appendFileSync(
    join(root, "mcp.jsonl"),
    JSON.stringify({ method, key, argument, server: name, pid: process.pid }) + "\n",
  )
record("start")
process.on("exit", () => record("exit"))
if (await Filesystem.isFile(join(root, "mcp-start-fail"))) throw new Error("S06_CONTROLLED_START_FAILURE")
const server = new Server(
  { name: "i1-sequence", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
)
server.oninitialized = () => record("initialized")
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "lookup",
      description: "Read a synthetic marker with key=current",
      inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    },
  ],
}))
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  record("call", request.params.arguments?.key)
  if (request.params.arguments?.key !== "current")
    return { isError: true, content: [{ type: "text", text: "INVALID_KEY: use key=current" }] }
  return { content: [{ type: "text", text: await Filesystem.readText(join(root, "mcp-marker.txt")) }] }
})
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{ uri: "sequence://marker", name: "sequence-marker", mimeType: "text/plain" }],
}))
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  record("resource", request.params.uri)
  if (request.params.uri !== "sequence://marker") throw new Error("UNKNOWN_RESOURCE")
  if (await Filesystem.isFile(join(root, "mcp-resource-fail"))) throw new Error("S06_RESOURCE_UNAVAILABLE")
  return {
    contents: [
      {
        uri: request.params.uri,
        mimeType: "text/plain",
        text: await Filesystem.readText(join(root, "mcp-marker.txt")),
      },
    ],
  }
})
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: "report",
      description: "Report a synthetic resource marker",
      arguments: [{ name: "label", required: true }],
    },
  ],
}))
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const label = request.params.arguments?.label
  record(
    "prompt",
    request.params.name,
    label === "$1" ? "placeholder" : label?.startsWith("S06_LABEL_") ? "synthetic-label" : "other",
  )
  if (request.params.name !== "report" || !request.params.arguments?.label) throw new Error("INVALID_PROMPT")
  return {
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `S06_PROMPT label=${request.params.arguments.label}; use lookup key=current and report its marker`,
        },
      },
    ],
  }
})
await server.connect(new StdioServerTransport())
