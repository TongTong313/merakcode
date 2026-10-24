import { expect, test } from "vitest"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { Instance } from "../../src/project/instance"
import { FileTime } from "../../src/file/time"
import { tmpdir } from "../fixture/fixture"
import { runAdmitted } from "../../src/collaboration/schedule"

/** Whether a Merak write to file gets in while an external member holds paths */
async function blocked(directory: string, hold: { product: string; paths: string[] }, file: string) {
  let entered = false
  const running = runAdmitted("locks", { seatID: "seat", ...hold }, () => delay(80))
  await delay(20)
  const write = FileTime.withLock(path.join(directory, file), async () => {
    entered = true
  })
  await delay(20)
  const result = !entered
  await Promise.all([running, write])
  return result
}

test("while an external member works on src/pay/**, Merak's writes under it wait and others do not", async () => {
  await using project = await tmpdir()
  await Instance.provide({
    directory: project.path,
    fn: async () => {
      expect(await blocked(project.path, { product: "codex", paths: ["src/pay/**"] }, "src/pay/a.ts")).toBe(true)
      expect(await blocked(project.path, { product: "codex", paths: ["src/pay/**"] }, "src/auth/a.ts")).toBe(false)
      expect(await blocked(project.path, { product: "codex", paths: [] }, "src/auth/a.ts")).toBe(true)
    },
  })
})

test("a writing bash command waits for an external member, and a member waits for a running bash command", async () => {
  await using project = await tmpdir()
  await Instance.provide({
    directory: project.path,
    fn: async () => {
      const order: string[] = []
      const member = runAdmitted("locks", { seatID: "seat", product: "codex", paths: ["src/pay/**"] }, async () => {
        await delay(60)
        order.push("member done")
      })
      await delay(10)
      const release = await FileTime.acquireBarrier()
      order.push("bash starts")
      const next = runAdmitted("locks", { seatID: "other", product: "codex", paths: ["docs/**"] }, async () => {
        order.push("next member starts")
      })
      await delay(30)
      order.push("bash done")
      release()
      await Promise.all([member, next])
      expect(order).toEqual(["member done", "bash starts", "bash done", "next member starts"])
    },
  })
})

test("a Merak member holds no lock, so its own writes go through", async () => {
  await using project = await tmpdir()
  await Instance.provide({
    directory: project.path,
    fn: async () => {
      const wrote = await Promise.race([
        runAdmitted("locks", { seatID: "merak", product: "merak", paths: [] }, () =>
          FileTime.withLock(path.join(project.path, "a.ts"), async () => "wrote"),
        ),
        delay(500).then(() => "stuck"),
      ])
      expect(wrote).toBe("wrote")
    },
  })
})
