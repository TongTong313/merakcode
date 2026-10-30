import { expect, test } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { Identifier } from "@merakcode/util/id"
import { Instance } from "../../src/infra/project/instance"
import { Session } from "../../src/agent/session"
import { Todo } from "../../src/agent/session/todo"
import { DelegateTool } from "../../src/app/task/tools/delegate"
import { create, load } from "../../src/app/task/collaboration/store"
import { tmpdir } from "../fixture/fixture"

/** A local OpenAI-compatible model that streams the same text for every request and records the tools it was offered */
async function model(text: string) {
  const tools: string[][] = []
  const server = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    const offered = (JSON.parse(body || "{}") as { tools?: { function: { name: string } }[] }).tools
    if (offered) tools.push(offered.map((tool) => tool.function.name))
    const chunks = [
      {
        id: "x",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: text } }],
      },
      {
        id: "x",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      },
    ]
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  return { url, tools, [Symbol.dispose]: () => server.close() }
}

/** Delegates to a MerakCode member in a group whose model always answers with text */
async function delegateToMerak(text: string) {
  using fake = await model(text)
  await using tmp = await tmpdir({
    git: true,
    config: {
      enabled_providers: ["fake"],
      provider: {
        fake: {
          name: "Fake",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: { m: { name: "M", tool_call: true, limit: { context: 32_000, output: 1_024 } } },
          options: { apiKey: "k", baseURL: fake.url },
        },
      },
    },
  })
  return await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ metadata: { group: true } })
      await create(session.id, { leader: { name: "小主" }, seats: [{ name: "小明", product: "merak" }] })
      const user = await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID: session.id,
        agent: "build",
        model: { providerID: "fake", modelID: "m" },
        time: { created: Date.now() },
      })
      const reply = await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "assistant",
        sessionID: session.id,
        mode: "build",
        agent: "build",
        path: { cwd: tmp.path, root: tmp.path },
        cost: 0,
        tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "m",
        providerID: "fake",
        parentID: user.id,
        time: { created: Date.now() },
      })
      const tool = await DelegateTool.init()
      const outcome = await tool
        .execute(
          { seat: "小明", task: "看退款边界" },
          {
            sessionID: session.id,
            messageID: reply.id,
            callID: "call",
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            ruleset: [],
            metadata: () => {},
            ask: async () => {},
          },
        )
        .then(
          (result) => ({ output: result.output, sessionId: result.metadata.sessionId }),
          (error: Error) => ({ error: error.message }),
        )
      const children = await Session.children(session.id)
      return {
        outcome,
        children: children.map((child) => child.id),
        results: (await load(session.id))!.results.map((item) => item.text),
        todos: (await Todo.get(session.id)).map((item) => item.status),
        tools: fake.tools,
      }
    },
  })
}

test("a MerakCode member works in a child session of the group and its reply is the result", async () => {
  const { outcome, children, results, todos, tools } = await delegateToMerak("退款边界看完了")
  expect(outcome).toEqual({ output: "退款边界看完了", sessionId: children[0] })
  expect(children).toHaveLength(1)
  expect(results).toEqual(["退款边界看完了"])
  expect(todos).toEqual(["completed"])
  // It can work with files but cannot start another member
  expect(tools.length).toBeGreaterThan(0)
  expect(tools.every((names) => names.includes("write") && !names.includes("delegate"))).toBe(true)
})

test("a MerakCode member that replies with nothing gives no result and its todo item stays open", async () => {
  const { outcome, results, todos } = await delegateToMerak("")
  expect(outcome).toEqual({ error: "小明 returned no reply" })
  expect(results).toEqual([])
  expect(todos).toEqual(["pending"])
})
