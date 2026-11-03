import { expect, test } from "vitest"
import path from "node:path"
import { Runtime } from "@merakcode/util/runtime"
import { Server } from "../../src/app/server/server"
import { Instance } from "../../src/infra/project/instance"
import { configureConnections } from "../fixture/agent-connections"
import { tmpdir } from "../fixture/fixture"

test.each(["failed", "stopped"] as const)(
  "a real external %s operation cannot complete or lock the official plan",
  async (status) => {
    await using tmp = await tmpdir()
    await configureConnections({
      "operation-plan": {
        command: process.execPath,
        adapter: "member",
        args: [
          ...Runtime.execArgv(),
          path.join(import.meta.dirname, "../collaboration/fixture/operation-adapter.ts"),
          status,
        ],
      },
    })
    const app = Server.App()
    const request = (url: string, method = "GET", body?: unknown) =>
      app.request(`${url}?directory=${encodeURIComponent(tmp.path)}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    try {
      const session = await (
        await request("/session", "POST", {
          title: "Operation outcome",
          target: { kind: "external", productID: "operation-plan" },
        })
      ).json()
      await request(`/session/${session.id}/permission-level`, "POST", {
        permissionLevel: "fullTakeover",
        expectedRevision: 0,
      })
      await request(`/session/${session.id}/plan`, "PUT", {
        content: "# Execute the controlled operation",
        expectedRevision: 0,
      })
      const response = await request(`/session/${session.id}/message`, "POST", {
        parts: [{ type: "text", text: "开始执行" }],
      })
      expect(response.status).toBe(200)
      const result = await response.json()
      if (status === "failed") expect(result.info.error.data.message).toMatch(/操作失败|operation failed/)
      const plan = await (await request(`/session/${session.id}/plan`)).json()
      expect(plan.status).toBe(status)
      expect(plan.buttonLocked).toBe(false)
    } finally {
      await Instance.disposeAll()
    }
  },
  20000,
)
