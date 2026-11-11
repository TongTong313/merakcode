import { execFile, spawn } from "node:child_process"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import { expect, it } from "vitest"
import { connect, watchConversation, type Conversation } from "../src/index"

it("lists and deletes a scheduled task that the model created, through the SDK", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "merakcode-sdk-schedule-"))
  const binary =
    process.env.MERAKCODE_TEST_BINARY ?? path.join(home, process.platform === "win32" ? "merak.exe" : "merak")
  if (!process.env.MERAKCODE_TEST_BINARY)
    await promisify(execFile)("go", ["build", "-o", binary, "./cmd/merak"], {
      cwd: path.resolve(import.meta.dirname, "../../../merak"),
      windowsHide: true,
    })
  const script = path.join(home, "replies.json")
  await writeFile(
    script,
    JSON.stringify([
      {
        calls: [
          { id: "create", name: "schedule_create", input: { cron: "0 9 * * 1-5", prompt: "Check the deployment" } },
        ],
      },
      { text: "Scheduled." },
    ]),
  )
  const child = spawn(binary, ["serve", "--script", script], {
    env: { ...process.env, MERAKCODE_HOME: home },
    stdio: "ignore",
    windowsHide: true,
  })
  try {
    let info: { endpoint: string; token: string } | undefined
    for (let attempt = 0; attempt < 250 && !info; attempt++) {
      if (child.exitCode !== null) throw new Error(`Engine exited with ${child.exitCode}`)
      info = await readFile(path.join(home, "data", "engine.json"), "utf8")
        .then((body) => JSON.parse(body) as { endpoint: string; token: string })
        .catch(() => undefined)
      if (!info) await delay(20)
    }
    if (!info) throw new Error("Engine did not publish connection information")
    const client = await connect(info)
    try {
      expect(await client.schedule.list()).toEqual([])
      const created = await client.session.create({ provider: "fake", workdir: home, mode: "takeover" })
      let view: Conversation | undefined
      const watching = await watchConversation(client, created.session, (value) => {
        view = value
      })
      try {
        await client.session.send({
          session: created.session,
          parts: [{ text: "Check the deployment on weekdays at nine" }],
        })
        await expect.poll(() => view?.state.status).toBe("done")
      } finally {
        await watching.close()
      }
      const listed = await client.schedule.list()
      expect(listed).toHaveLength(1)
      expect(listed?.[0]).toMatchObject({ cron: "0 9 * * 1-5", prompt: "Check the deployment" })
      expect(Date.parse(listed![0]!.next ?? "")).toBeGreaterThan(Date.now())
      await expect(client.schedule.delete({ id: "nothing" })).rejects.toThrow("MRK-4014")
      await client.schedule.delete({ id: listed![0]!.id })
      expect(await client.schedule.list()).toEqual([])
    } finally {
      await client.close()
    }
  } finally {
    child.kill()
  }
}, 60000)
