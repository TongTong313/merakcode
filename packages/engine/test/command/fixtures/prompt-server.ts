import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"

const server = new Server({ name: "command-cache-fixture", version: "1" }, { capabilities: { prompts: {}, tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [{ name: "greeting", description: "Greeting fixture", arguments: [{ name: "person", required: true }] }],
}))
server.setRequestHandler(GetPromptRequestSchema, async (request) => ({
  messages: [{ role: "user", content: { type: "text", text: `Hello ${request.params.arguments?.person}` } }],
}))
await server.connect(new StdioServerTransport())
