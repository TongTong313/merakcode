import { expect, test } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { smokeEvidence } from "../script/smoke-evidence"

test("the primary failure is on disk before browser inspection starts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "merakcode-smoke-evidence-"))
  const file = path.join(root, "error.txt")
  const inspected = Promise.withResolvers<void>()
  const release = Promise.withResolvers<string>()
  const saving = smokeEvidence(file, "shutdown\nexit signal SIGKILL\n", () => {
    inspected.resolve()
    return release.promise
  })
  try {
    await inspected.promise
    expect(await readFile(file, "utf8").catch(() => "missing")).toBe("shutdown\nexit signal SIGKILL\n")
  } finally {
    release.resolve("browser details")
    await saving
    await rm(root, { recursive: true, force: true })
  }
})

test("unresponsive browser inspection leaves the failure on disk and returns by its deadline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "merakcode-smoke-evidence-"))
  const file = path.join(root, "error.txt")
  const release = Promise.withResolvers<string>()
  const saving = smokeEvidence(file, "shutdown failed\n", () => release.promise, 100)
  try {
    expect(await Promise.race([saving.then(() => "finished"), delay(1000, "still waiting")])).toBe("finished")
    expect(await readFile(file, "utf8")).toContain("shutdown failed\n")
    expect(await readFile(file, "utf8")).toContain("Browser inspection timed out")
  } finally {
    release.resolve("late browser details")
    await saving
    await rm(root, { recursive: true, force: true })
  }
})
