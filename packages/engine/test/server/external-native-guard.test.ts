import { expect, test } from "vitest"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"
import { configureConnections } from "../fixture/agent-connections"
import { fakeModel } from "../../../sdk/js/test/fixture/model"

test("refuses a native subagent task that reuses an external conversation", async () => {
  let targetID = ""
  const model = await fakeModel((turn) => {
    if (turn.prompt === "try external reuse" && !turn.results.length)
      return {
        tool: "subagent",
        args: {
          description: "Reuse a task",
          prompt: "Nested native execution must not start",
          subagent_type: "general",
          task_id: targetID,
        },
      }
    return { text: "Finished" }
  })
  try {
    await configureConnections({ external: { command: process.execPath } })
    await using project = await tmpdir({
      git: true,
      config: {
        model: "alibaba-cn/qwen-plus",
        small_model: "alibaba-cn/qwen-plus",
        enabled_providers: ["alibaba-cn"],
        provider: { "alibaba-cn": { options: { apiKey: "fake", baseURL: model.url } } },
        memory: { auto_extract: false, auto_recall: false, auto_dream: false, session_memory: false },
        lsp: false,
      },
    })
    const app = Server.App()
    const request = (url: string, body?: unknown) =>
      app.request(
        `${url}?directory=${encodeURIComponent(project.path)}`,
        body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {},
      )
    targetID = (await (await request("/session", { target: { kind: "external", productID: "external" } })).json()).id
    const nativeID = (await (await request("/session", {})).json()).id
    const response = await request(`/session/${nativeID}/message`, {
      parts: [{ type: "text", text: "try external reuse" }],
      permissionMode: "auto",
    })
    expect(response.status).toBe(200)
    await response.text()
    expect(model.turns.some((turn) => turn.tools.includes("subagent"))).toBe(true)
    const messages = await (await request(`/session/${nativeID}/message`)).json()
    const calls = messages
      .flatMap(
        (message: { parts: { type: string; tool?: string; state?: { status: string; error?: string } }[] }) =>
          message.parts,
      )
      .filter((part: { type: string; tool?: string }) => part.type === "tool" && part.tool === "subagent")
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: expect.objectContaining({ status: "error", error: expect.stringMatching(/external/i) }),
        }),
      ]),
    )
    expect(await (await request(`/session/${targetID}/message`)).json()).toEqual([])
  } finally {
    await model.close()
  }
}, 30_000)
