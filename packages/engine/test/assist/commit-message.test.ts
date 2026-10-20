import { afterAll, describe, expect, test } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import { AssistRoutes } from "@merakcode/engine/server/routes/assist"
import { Instance } from "@merakcode/engine/project/instance"
import { Log } from "@merakcode/log/logger"
import { Process } from "@merakcode/util/process"

Log.init({ print: false })

async function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-commit-"))
  await Process.run(["git", "init", "-q"], { cwd: dir })
  await Process.run(["git", "config", "user.email", "t@t.io"], { cwd: dir })
  await Process.run(["git", "config", "user.name", "t"], { cwd: dir })
  fs.writeFileSync(path.join(dir, "README.md"), "# hello\n")
  await Process.run(["git", "add", "-A"], { cwd: dir })
  await Process.run(["git", "commit", "-q", "-m", "chore: init"], { cwd: dir })
  return dir
}

const cleanup: string[] = []
afterAll(() => {
  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true })
})

// Only model-free, deterministic checks live here (git reads and the empty-change guard). Prompt building and output
// cleanup are covered by commit-message-logic.test.ts; generation with a real model is verified manually because it
// depends on the runtime environment.
describe("POST /assist/commit-message", () => {
  test("returns an empty message without calling the model when the worktree is clean", async () => {
    const dir = await makeRepo()
    cleanup.push(dir)

    const res = await Instance.provide({
      directory: dir,
      fn: () => AssistRoutes().request("/commit-message", { method: "POST" }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ message: "" })
  })
})
