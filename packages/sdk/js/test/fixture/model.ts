/**
 * Local fake model: an OpenAI-compatible streaming endpoint (the same kind as the desktop end-to-end tests), with no
 * network access and no cost. Based on the turn's latest user message and the tool results so far, it replies with
 * text or makes a tool call.
 */
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

/**
 * reasoning: streams thinking first (reasoning_content of the OpenAI-compatible API), then the text; status: replies
 * with an OpenAI-style error with this HTTP status
 */
export type Reply =
  | { text: string; reasoning?: string }
  | { tool: string; args: Record<string, unknown> }
  | { status: number; message: string }

export type Turn = {
  /** Text of the latest user message */
  prompt: string
  /** Tool results received so far in this turn, in order */
  results: string[]
  /** Names of the tools available to the model in this request */
  tools: string[]
  system: string
}

type Message = { role: string; content?: unknown }

const text = (content: unknown) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part: { text?: string }) => part.text ?? "").join("")
      : ""

function chunk(delta: object, finish: string | null = null) {
  return `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
}

/** The last chunk carries usage like a real model does (subagents rely on it to tell that they actually ran) */
function end(finish: string) {
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  return (
    `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n` +
    "data: [DONE]\n\n"
  )
}

function body(reply: Reply) {
  if ("text" in reply)
    return (
      (reply.reasoning ? chunk({ role: "assistant", reasoning_content: reply.reasoning }) : "") +
      chunk({ role: "assistant", content: reply.text }) +
      end("stop")
    )
  const call = {
    index: 0,
    id: `call_${Math.random().toString(36).slice(2)}`,
    type: "function",
    function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
  }
  return chunk({ role: "assistant", tool_calls: [call] }) + end("tool_calls")
}

/** Background requests such as titles and summaries carry no tools and get a fixed reply */
export async function fakeModel(script: (turn: Turn) => Reply | Promise<Reply>) {
  const turns: Turn[] = []
  const server = createServer(async (request, response) => {
    let raw = ""
    for await (const part of request) raw += part
    const input = JSON.parse(raw || "{}") as { messages?: Message[]; tools?: { function: { name: string } }[] }
    const messages = input.messages ?? []
    const tools = (input.tools ?? []).map((item) => item.function.name)
    if (tools.length === 0) {
      response.writeHead(200, { "content-type": "text/event-stream" })
      return response.end(body({ text: "OK" }))
    }
    const last = messages.findLastIndex((message) => message.role === "user")
    const turn = {
      prompt: text(messages[last]?.content),
      results: messages.slice(last + 1).flatMap((message) => (message.role === "tool" ? [text(message.content)] : [])),
      tools,
      system: messages
        .filter((message) => message.role === "system")
        .map((message) => text(message.content))
        .join("\n"),
    }
    turns.push(turn)
    const reply = await Promise.resolve(script(turn)).catch((error: Error) => ({
      text: `SCRIPT_ERROR ${error.message}`,
    }))
    if ("status" in reply) {
      response.writeHead(reply.status, { "content-type": "application/json" })
      return response.end(JSON.stringify({ error: { message: reply.message, type: "invalid_request_error" } }))
    }
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end(body(reply))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/v1`,
    turns,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
