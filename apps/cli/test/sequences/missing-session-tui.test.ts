import { expect, test } from "vitest"
import { join } from "node:path"
import { sequence } from "../fixture/sdk-sequence"
import { drive } from "../fixture/sequence-driver"
import { pty } from "../fixture/sequence-pty"
import { Filesystem } from "@merakcode/util/filesystem"
import { setTimeout as delay } from "node:timers/promises"

test("S14.13 P/M+T opening a deleted session shows recovery and creates a distinct working session", async () => {
  const kit = await sequence("read")
  let terminal: Awaited<ReturnType<typeof pty>> | undefined
  let success = false
  try {
    const other = await kit.api("/session", "POST", { title: "S14.13 protected other session" })
    const task = await drive(kit, other.id, "S14_OTHER 读取真实标记")
    await kit.assertResult(other.id, task.userID)
    const history = await kit.api(`/session/${other.id}/message`)
    const gone = await kit.api("/session", "POST", { title: "S14.13 deleted target" })
    await kit.api(`/session/${gone.id}`, "DELETE")
    const missing = await fetch(`${kit.url}/session/${gone.id}`, {
      headers: { "x-merakcode-directory": kit.project },
    })
    expect(missing.status).toBe(404)
    const requests = kit.modelRequests()
    terminal = await pty(kit, gone.id, "S14.13 deleted target")
    const errorShown = await terminal
      .wait(
        () => terminal!.visible("未找到会话:") || terminal!.visible("Session not found:"),
        "real missing-session error shown",
      )
      .then(
        () => true,
        () => false,
      )
    expect(kit.modelRequests()).toBe(requests)
    expect(await kit.api(`/session/${other.id}/message`)).toEqual(history)
    const before = (await kit.api("/session")).map((item: { id: string }) => item.id)
    if (!errorShown) {
      await terminal.submit("/new")
      await delay(150)
    }
    const input = "S14_RECOVER 从缺失会话返回后创建新任务并读取真实标记"
    const sent = await terminal.submit(input)
    await terminal.wait(() => terminal!.visible("I1_DONE", sent), "new task after missing-session recovery")
    const created = (await kit.api("/session")).filter((item: { id: string }) => !before.includes(item.id))
    expect(created).toHaveLength(1)
    expect(created[0].id).not.toBe(gone.id)
    expect(created[0].id).not.toBe(other.id)
    const userID = await kit.submitted(created[0].id, input)
    await kit.assertResult(created[0].id, userID)
    expect(await kit.api(`/session/${other.id}/message`)).toEqual(history)
    expect((await kit.api("/session/status"))[created[0].id]?.type ?? "idle").toBe("idle")
    await Filesystem.write(
      join(kit.artifacts, "sequence.json"),
      JSON.stringify({
        id: "S14.13",
        layer: "P/M+T",
        missingSessionID: gone.id,
        protectedSessionID: other.id,
        recoveredSessionID: created[0].id,
        userID,
        initialStatus: 404,
        errorShown,
        modelRequestsBeforeRecovery: requests,
      }),
    )
    expect(errorShown).toBe(true)
    success = true
  } finally {
    try {
      await terminal?.close()
    } finally {
      await kit.finish(success)
    }
  }
}, 120_000)
