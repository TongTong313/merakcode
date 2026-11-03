import { expect, test } from "vitest"
import path from "node:path"
import { fakeModel } from "../../../sdk/js/test/fixture/model"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/infra/project/instance"
import { Server } from "../../src/app/server/server"
import { Filesystem } from "@merakcode/util/filesystem"

test("imported history clears untrusted task sources before a new draft-only task", async () => {
  const model = await fakeModel((turn) =>
    turn.results.length === 0
      ? { tool: "write", args: { filePath: "effect.txt", content: "CHANGED" } }
      : { text: "Draft task complete" },
  )
  try {
    await using tmp = await tmpdir({
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
    const request = (url: string, method = "GET", body?: unknown) =>
      Server.App().request(`${url}?directory=${encodeURIComponent(tmp.path)}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    const original = await (await request("/session", "POST", {})).json()
    const exported = await (await request(`/session/${original.id}/export-full`)).json()
    exported.info.taskOrigin = { sessionID: "ses_missing_source", messageID: "msg_missing_source" }
    const imported = await (await request("/session/import-full", "POST", exported)).json()
    await request(`/session/${imported.info.id}/permission-level`, "POST", {
      permissionLevel: "fullTakeover",
      expectedRevision: 0,
    })
    await (
      await request(`/session/${imported.info.id}/message`, "POST", {
        parts: [{ type: "text", text: "只出稿，不要修改项目。" }],
      })
    ).json()
    const history = await (await request(`/session/${imported.info.id}/message`)).json()
    const writes = history
      .flatMap((message: any) => message.parts)
      .filter((p: any) => p.type === "tool" && p.tool === "write")
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ state: { status: "error", error: expect.stringMatching(/MRK-5014/) } })
    expect(await Filesystem.exists(path.join(tmp.path, "effect.txt"))).toBe(false)
    expect(imported.info.taskOrigin).toBeUndefined()
  } finally {
    await Instance.disposeAll()
    await model.close()
  }
}, 20000)
