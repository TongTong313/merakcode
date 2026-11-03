import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { Runtime } from "@merakcode/util/runtime"
import { Server } from "../../src/app/server/server"
import { Instance } from "../../src/infra/project/instance"
import { configureConnections } from "../fixture/agent-connections"
import { tmpdir } from "../fixture/fixture"

test.each(["scope", "plan"] as const)(
  "external %s stays bound while a later request is saved",
  async (kind) => {
    await using tmp = await tmpdir()
    const gate = path.join(tmp.path, "release")
    await configureConnections({
      guarded: {
        command: process.execPath,
        adapter: "member",
        args: [
          ...Runtime.execArgv(),
          path.join(import.meta.dirname, "fixture/external-adapter.ts"),
          `${kind}-gate`,
          gate,
        ],
      },
    })
    const request = (url: string, method = "GET", body?: unknown) =>
      Server.App().request(`${url}?directory=${encodeURIComponent(tmp.path)}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    try {
      const session = await (
        await request("/session", "POST", { target: { kind: "external", productID: "guarded" } })
      ).json()
      await request(`/session/${session.id}/permission-level`, "POST", {
        permissionLevel: "fullTakeover",
        expectedRevision: 0,
      })
      if (kind === "plan")
        await request(`/session/${session.id}/plan`, "PUT", { content: "DRAFT_A", expectedRevision: 0 })
      await request(`/session/${session.id}/prompt_async`, "POST", {
        parts: [{ type: "text", text: kind === "scope" ? "只出稿，不要修改项目。" : "解释计划" }],
      })
      await expect
        .poll(
          () =>
            fs.access(`${gate}.started`).then(
              () => true,
              () => false,
            ),
          { timeout: 10000 },
        )
        .toBe(true)
      const messages = async () => await (await request(`/session/${session.id}/message`)).json()
      if (kind === "scope") {
        await request(`/session/${session.id}/prompt_async`, "POST", {
          parts: [{ type: "text", text: "开始实施新任务" }],
        })
        await expect.poll(async () => (await messages()).filter((m: any) => m.info.role === "user").length).toBe(2)
      } else {
        await request(`/session/${session.id}/plan`, "PUT", { content: "DRAFT_B", expectedRevision: 1 })
      }
      await fs.writeFile(gate, "release")
      await expect
        .poll(
          async () =>
            (await messages()).filter((m: any) => m.info.role === "assistant").every((m: any) => !!m.info.terminal),
          { timeout: 10000 },
        )
        .toBe(true)
      const replies = (await messages()).filter((m: any) => m.info.role === "assistant")
      expect(replies.length).toBeGreaterThan(0)
      if (kind === "scope") {
        expect(replies[0].parts.some((p: any) => p.type === "text" && p.text === "DENIED")).toBe(true)
        await expect(fs.stat(path.join(tmp.path, "effect.txt"))).rejects.toMatchObject({ code: "ENOENT" })
      } else {
        expect(replies[0].info.error).toMatchObject({ name: "PlanConflictError" })
        await expect(fs.stat(`${gate}.received`)).rejects.toMatchObject({ code: "ENOENT" })
      }
    } finally {
      await fs.writeFile(gate, "release")
      await Instance.disposeAll()
    }
  },
  25000,
)
