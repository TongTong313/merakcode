import { expect, test } from "vitest"
import { createMerakCode } from "@merakcode/sdk"
import { engine, sandbox } from "../fixture/engine"
import { fakeModel } from "../fixture/model"

test("SDK clients can restart a failed chat rerun after a successful button execution", async () => {
  const received: string[] = []
  const model = await fakeModel((turn) => {
    received.push(JSON.stringify(turn.request))
    if (turn.prompt === "开始执行") return { status: 400, message: "Controlled retry failure" }
    return { text: "PLAN_DONE" }
  })
  await using env = await sandbox(model.url)
  const merak = await createMerakCode({ cwd: env.project, executablePath: engine, env: env.env })
  try {
    const session = await merak.session()
    const client = merak.client.session
    const plan = async () => (await client.planGet({ sessionID: session.id }, { throwOnError: true })).data
    await client.planSave({ sessionID: session.id, content: "SDK_PLAN_A", expectedRevision: 0 }, { throwOnError: true })
    await client.planStart({ sessionID: session.id }, { throwOnError: true })
    await expect.poll(async () => (await plan()).status, { timeout: 10000 }).toBe("completed")
    expect((await plan()).buttonLocked).toBe(true)
    await client.prompt({ sessionID: session.id, parts: [{ type: "text", text: "开始执行" }] }, { throwOnError: true })
    const failed = await plan()
    expect(failed).toMatchObject({ status: "failed", buttonLocked: false })
    await client.planStart({ sessionID: session.id }, { throwOnError: true })
    await expect.poll(async () => (await plan()).status, { timeout: 10000 }).toBe("completed")
    const retried = await plan()
    expect(retried.execution?.id).not.toBe(failed.execution?.id)
    expect(retried.execution).toMatchObject({ content: "SDK_PLAN_A", source: "button" })
    expect(retried.buttonLocked).toBe(true)
    expect(received).toHaveLength(3)
    expect(received.every((request) => request.includes("SDK_PLAN_A"))).toBe(true)
  } finally {
    await merak.close()
    await model.close()
  }
}, 60000)
