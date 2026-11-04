import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { Server } from "../../src/app/server/server"
import { Instance } from "../../src/infra/project/instance"
import { Runtime } from "@merakcode/util/runtime"
import { SessionPlan } from "../../src/agent/session/plan"
import { tmpdir } from "../fixture/fixture"
import { configureConnections } from "../fixture/agent-connections"

test.each(["ask", "autoApprove", "fullTakeover"] as const)(
  "external button and chat starts preserve %s and receive the official snapshot",
  async (permissionLevel) => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "received")
    await configureConnections({
      "plan-fixture": {
        command: process.execPath,
        adapter: "member",
        args: [
          ...Runtime.execArgv(),
          path.join(import.meta.dirname, "fixture/external-adapter.ts"),
          "plan-input",
          file,
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
      const ordinary = await (
        await request("/session", "POST", {
          title: "No official plan",
          target: { kind: "external", productID: "plan-fixture" },
        })
      ).json()
      const ordinaryReply = await request(`/session/${ordinary.id}/message`, "POST", {
        parts: [{ type: "text", text: "Explain the plan concept" }],
      })
      await ordinaryReply.json()
      expect(JSON.parse(await fs.readFile(file, "utf8")).plan).toBeUndefined()
      for (const source of ["button", "chat"] as const) {
        const created = await (
          await request("/session", "POST", {
            title: "External plan",
            target: { kind: "external", productID: "plan-fixture" },
          })
        ).json()
        expect(
          (await request(`/session/${created.id}/permission-level`, "POST", { permissionLevel, expectedRevision: 0 }))
            .status,
        ).toBe(200)
        expect(
          (
            await request(`/session/${created.id}/plan`, "PUT", {
              content: `# Approved ${source}`,
              expectedRevision: 0,
            })
          ).status,
        ).toBe(200)
        if (source === "button") expect((await request(`/session/${created.id}/plan/start`, "POST")).status).toBe(200)
        else
          expect(
            (
              await request(`/session/${created.id}/message`, "POST", {
                parts: [{ type: "text", text: "按原计划再做一遍" }],
              })
            ).status,
          ).toBe(200)
        await expect
          .poll(
            async () => {
              const plan = await (await request(`/session/${created.id}/plan`)).json()
              return plan.status
            },
            { timeout: 10000 },
          )
          .toBe("completed")
        const received = JSON.parse(await fs.readFile(file, "utf8"))
        expect(received.permissionLevel).toBe(permissionLevel)
        expect(received.plan).toMatchObject({ content: `# Approved ${source}`, revision: 1 })
        expect(received.prompt).toContain(`# Approved ${source}`)
        const plan = await (await request(`/session/${created.id}/plan`)).json()
        expect(plan.execution).toMatchObject({ source, content: `# Approved ${source}` })
        expect((await (await request(`/session/${created.id}`)).json()).permissionLevel).toBe(permissionLevel)
        expect(
          (
            await request(`/session/${created.id}/plan`, "PUT", {
              content: "# Human discussion draft B",
              expectedRevision: 1,
            })
          ).status,
        ).toBe(200)
        const discussionResponse = await request(`/session/${created.id}/message`, "POST", {
          parts: [{ type: "text", text: "解释计划第二步" }],
        })
        expect(discussionResponse.status).toBe(200)
        expect((await discussionResponse.json()).info).toMatchObject({ terminal: "completed" })
        const discussion = JSON.parse(await fs.readFile(file, "utf8"))
        expect(discussion.plan).toMatchObject({ content: "# Human discussion draft B", revision: 2 })
        expect(discussion.prompt).toContain("# Human discussion draft B")
        expect((await (await request(`/session/${created.id}/plan`)).json()).execution.id).toBe(plan.execution.id)
      }
    } finally {
      await Instance.disposeAll()
    }
  },
  30000,
)

test("an external capacity shrink pauses a restored execution and resumes the same snapshot", async () => {
  await using tmp = await tmpdir()
  const capacity = path.join(tmp.path, "capacity")
  const received = path.join(tmp.path, "received")
  await fs.writeFile(capacity, "10000")
  await configureConnections({
    "resume-plan": {
      command: process.execPath,
      adapter: "member",
      args: [
        ...Runtime.execArgv(),
        path.join(import.meta.dirname, "fixture/external-adapter.ts"),
        "plan-capacity",
        capacity,
        received,
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
      await request("/session", "POST", {
        title: "External resume",
        target: { kind: "external", productID: "resume-plan" },
      })
    ).json()
    await request(`/session/${session.id}/permission-level`, "POST", {
      permissionLevel: "fullTakeover",
      expectedRevision: 0,
    })
    const content = "SNAPSHOT_A_" + "x".repeat(104000)
    await request(`/session/${session.id}/plan`, "PUT", { content, expectedRevision: 0 })
    const started = await Instance.provide({
      directory: tmp.path,
      fn: () => SessionPlan.start(session.id, "button", 1),
    })
    await request(`/session/${session.id}/plan`, "PUT", { content: "LATEST_HUMAN_B", expectedRevision: 1 })
    const paused = await (
      await request(`/session/${session.id}/message`, "POST", { parts: [{ type: "text", text: "继续执行当前任务" }] })
    ).json()
    expect(paused.info.error).toMatchObject({ name: "PlanCapacityError", code: "MRK-4013" })
    const getPlan = async () => await (await request(`/session/${session.id}/plan`)).json()
    expect(await getPlan()).toMatchObject({ status: "paused", execution: { id: started.execution!.id, content } })
    await expect(fs.stat(received)).rejects.toMatchObject({ code: "ENOENT" })
    await fs.writeFile(capacity, "200000")
    await (
      await request(`/session/${session.id}/message`, "POST", { parts: [{ type: "text", text: "继续执行当前任务" }] })
    ).json()
    expect(await getPlan()).toMatchObject({ status: "completed", execution: { id: started.execution!.id, content } })
    const task = JSON.parse(await fs.readFile(received, "utf8"))
    expect(task.plan).toMatchObject({ executionID: started.execution!.id, content })
    expect(task.prompt).not.toContain("LATEST_HUMAN_B")
  } finally {
    await Instance.disposeAll()
  }
}, 20000)
