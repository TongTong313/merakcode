import { execFile, spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"
import { promisify } from "node:util"

export async function cloudFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "merak-cloud-renderer-"))
  const binary = path.join(root, process.platform === "win32" ? "cloud.exe" : "cloud")
  await promisify(execFile)("go", ["build", "-o", binary, "./internal/testcloud/testdata/desktop"], {
    cwd: path.resolve(import.meta.dirname, "../../../../../merak"),
    windowsHide: true,
  })
  const child = spawn(binary, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true })
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  const lines = createInterface({ input: child.stdout })
  const endpoint = await new Promise<string>((resolve, reject) => {
    lines.once("line", resolve)
    child.once("error", reject)
    child.once("exit", () => reject(new Error("Cloud fixture exited before listening")))
  })
  lines.close()
  return {
    endpoint,
    close: async () => {
      child.stdin.end()
      await exited
      await rm(root, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}
