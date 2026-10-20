import { afterAll, beforeAll, expect, test } from "vitest"
import path from "path"
import { Agent } from "@merakcode/engine/agent/agent"
import { Instance } from "@merakcode/engine/project/instance"
import { Config } from "@merakcode/engine/config/config"
import { Filesystem } from "@merakcode/util/filesystem"
import { Http } from "@merakcode/util/http"
import { tmpdir } from "../fixture/fixture"

// `merak agent create` asks the model to generate an agent config from a description: the system prompt must be
// sent to the model and the reply parsed into a structured result.
const requests: Record<string, unknown>[] = []
let server: Http.Server

beforeAll(async () => {
  server = await Http.serve({
    port: 0,
    async fetch(req) {
      requests.push((await req.json()) as Record<string, unknown>)
      const content = JSON.stringify({ identifier: "reviewer", whenToUse: "Review diffs", systemPrompt: "You review." })
      return Response.json({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 0,
        model: "qwen-plus",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      })
    },
  })
})

afterAll(() => server.stop(true))

test("generates an agent from a description, sending the system prompt and parsing the structured reply", async () => {
  await using tmp = await tmpdir({
    init: (dir) =>
      Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          enabled_providers: ["alibaba"],
          provider: { alibaba: { options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1` } } },
        }),
      ),
  })
  const generated = await Instance.provide({
    directory: tmp.path,
    fn: () => Agent.generate({ description: "reviews diffs", model: { providerID: "alibaba", modelID: "qwen-plus" } }),
  })

  expect(generated).toEqual({ identifier: "reviewer", whenToUse: "Review diffs", systemPrompt: "You review." })
  const messages = requests[0]?.messages as { role: string; content: string }[]
  expect(messages[0]?.role).toBe("system")
  expect(messages.at(-1)?.content).toContain("reviews diffs")
})
