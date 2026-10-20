import { expect, test } from "vitest"
import path from "node:path"
import fs from "node:fs/promises"
import { Storage } from "../../src/storage/storage"
import { tmpdir, runtime } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"
import { setTimeout as delay } from "node:timers/promises"

test("another process never reads a partial JSON record during Storage.write or update", async () => {
  await using tmp = await tmpdir()
  const key = ["diagnostic", `multiprocess-${crypto.randomUUID()}`]
  const value = { id: "session-fixture", revision: 0, payload: "x".repeat(512 * 1024) }
  await Storage.write(key, value)
  const child = Process.spawn(
    [...runtime, path.join(import.meta.dirname, "storage-multiprocess-fixture.ts"), JSON.stringify(key)],
    {
      cwd: tmp.path,
      env: { ...process.env, NODE_OPTIONS: "" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const errors = new Response(child.stderr).text()
  const timer = setTimeout(() => child.kill(), 20_000)
  const failures: Array<{ name: string; code?: string }> = []
  let reads = 0
  try {
    const ready = await child.stdout!.getReader().read()
    expect(new TextDecoder().decode(ready.value).trim()).toBe("ready")
    child.stdin!.write("go\n")
    while (child.exitCode === null) {
      await Storage.read<typeof value>(key).then(
        (read) => {
          expect(read.id).toBe(value.id)
          expect(read.payload).toBe(value.payload)
          reads++
        },
        (error: unknown) =>
          failures.push({
            name: error instanceof Error ? error.name : "UnknownError",
            code: (error as NodeJS.ErrnoException).code,
          }),
      )
      await delay(1)
    }
    expect(await child.exited, await errors).toBe(0)
    expect(reads).toBeGreaterThan(0)
    expect(failures).toEqual([])
    expect((await Storage.read<typeof value>(key)).revision).toBe(60)
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill()
    await child.exited
    await Storage.remove(key)
  }
}, 30_000)

test("storage listing ignores temporary files left by an interrupted writer", async () => {
  const key = ["diagnostic", `listing-${crypto.randomUUID()}`]
  await Storage.write(key, { ready: true })
  const temporary = `${await Storage.targetPath(key)}.interrupted.tmp`
  try {
    await Filesystem.write(temporary, '{"incomplete":')
    const listed = await Storage.list(["diagnostic"])
    expect(listed).toContainEqual(key)
    expect(listed.some((item) => item.at(-1)?.includes("interrupted"))).toBe(false)
  } finally {
    await fs.unlink(temporary)
    await Storage.remove(key)
  }
})

test("failed replacement preserves the destination and removes its temporary file", async () => {
  const key = ["diagnostic", `blocked-${crypto.randomUUID()}`]
  const target = await Storage.targetPath(key)
  await fs.mkdir(target, { recursive: true })
  const marker = path.join(target, "original")
  await Filesystem.write(marker, "must survive")
  try {
    await expect(Storage.write(key, { replacement: true })).rejects.toThrow()
    expect(await Filesystem.readText(marker)).toBe("must survive")
    const siblings = await fs.readdir(path.dirname(target))
    expect(siblings.some((name) => name.startsWith(`${path.basename(target)}.`))).toBe(false)
  } finally {
    await fs.unlink(marker)
    await fs.rmdir(target)
  }
})
