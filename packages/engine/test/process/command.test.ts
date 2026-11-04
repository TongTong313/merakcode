import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { spawnOwnedCommand } from "../../src/infra/process/command"
import { tmpdir } from "../fixture/fixture"

test("cancellation before containment settles never starts the requested command", async () => {
  await using tmp = await tmpdir()
  const controller = new AbortController()
  const input: Parameters<typeof spawnOwnedCommand>[0] & { signal: AbortSignal } = {
    file: process.execPath,
    args: ["-e", "process.stdout.write('unexpected')"],
    cwd: tmp.path,
    env: process.env as Record<string, string>,
    signal: controller.signal,
    pick: async (text) => text.en,
  }
  let owned: Awaited<ReturnType<typeof spawnOwnedCommand>> | undefined
  const running = spawnOwnedCommand(input).then((value) => (owned = value))
  controller.abort(new Error("Cancelled before start"))
  try {
    await expect(running).rejects.toThrow("Cancelled before start")
  } finally {
    await owned?.stop()
  }
})

test("command NODE_OPTIONS never execute inside the host supervisor", async () => {
  await using tmp = await tmpdir()
  const preload = path.join(tmp.path, "preload.cjs")
  const marker = path.join(tmp.path, "preloaded")
  await fs.writeFile(preload, `require('fs').appendFileSync(${JSON.stringify(marker)}, String(process.pid)+'\\n')`)
  const owned = await spawnOwnedCommand({
    file: process.execPath,
    args: ["-e", "process.stdout.write('done')"],
    cwd: tmp.path,
    env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` } as Record<string, string>,
    pick: async (text) => text.en,
  })
  owned.proc.stdout?.resume()
  owned.proc.stderr?.resume()
  try {
    await new Promise<void>((resolve) => owned.proc.once("close", () => resolve()))
    const pids = (await fs.readFile(marker, "utf8")).trim().split("\n").map(Number)
    expect(pids).toHaveLength(1)
    expect(pids).not.toContain(owned.proc.pid)
  } finally {
    await owned.stop()
  }
})
