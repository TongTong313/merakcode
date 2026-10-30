import { expect, test } from "vitest"
import fs from "fs/promises"
import { existsSync } from "fs"
import path from "path"
import { pathToFileURL } from "url"
import { setTimeout as sleep } from "timers/promises"
import { Process } from "@merakcode/util/process"
import { evaluate, tmpdir } from "../fixture/fixture"

const global = pathToFileURL(path.join(import.meta.dirname, "../../src/infra/global/index.ts")).href
const start = (home: string) =>
  Process.spawn(evaluate(`const { Global } = await import(${JSON.stringify(global)}); await Global.initialize()`), {
    env: { ...process.env, MERAKCODE_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  })

/** A cache from an older engine version: an old version file and old files, some in bin */
async function oldCache(dir: string, files: number) {
  await fs.mkdir(path.join(dir, "cache", "bin"), { recursive: true })
  await fs.writeFile(path.join(dir, "cache", "version"), "0")
  await Promise.all(
    Array.from({ length: files }, (_, i) => fs.writeFile(path.join(dir, "cache", i % 2 ? "bin" : "", `old-${i}`), "x")),
  )
}

// Engines started together after the cache version changed each cleared the cache, so one removed what another had
// just created and that one failed to start (ENOENT on cache/bin). A full old cache makes the clearing take long
// enough for the starts to overlap.
test("engines starting together after a cache version change all start and clear the cache once", async () => {
  for (let round = 0; round < 10; round++) {
    await using home = await tmpdir({ init: (dir) => oldCache(dir, 2000) })
    const results = await Promise.all(
      Array.from({ length: 16 }, () =>
        Process.run(evaluate(`const { Global } = await import(${JSON.stringify(global)}); await Global.initialize()`), {
          env: { ...process.env, MERAKCODE_HOME: home.path },
          nothrow: true,
        }),
      ),
    )
    for (const result of results) expect(result.exitCode, `round ${round}: ${result.stderr.toString()}`).toBe(0)
    expect(await fs.readFile(path.join(home.path, "cache", "version"), "utf8")).not.toBe("0")
    expect(existsSync(path.join(home.path, "cache", "old-0"))).toBe(false)
    expect(existsSync(path.join(home.path, "cache", "bin"))).toBe(true)
  }
}, 180_000)

test("an engine waits while another clears the cache and keeps what that one left", async () => {
  await using home = await tmpdir({ init: (dir) => oldCache(dir, 4) })
  const lock = path.join(home.path, "cache", ".reset")
  await fs.mkdir(lock)
  const engine = start(home.path)
  try {
    await sleep(1_000)
    expect(engine.exitCode).toBeNull()
    expect(existsSync(path.join(home.path, "cache", "old-0"))).toBe(true)

    // The other engine finishes: its new cache is in place, so this one must not clear it again
    await fs.writeFile(path.join(home.path, "cache", "version"), "21")
    await fs.rm(lock, { recursive: true })
    expect(await engine.exited, await new Response(engine.stderr).text()).toBe(0)
    expect(existsSync(path.join(home.path, "cache", "old-0"))).toBe(true)
  } finally {
    if (engine.exitCode === null) engine.kill()
    await engine.exited
  }
}, 30_000)

test("a cache reset left behind by an engine that died is taken over", async () => {
  await using home = await tmpdir({ init: (dir) => oldCache(dir, 4) })
  const lock = path.join(home.path, "cache", ".reset")
  await fs.mkdir(lock)
  const long = new Date(Date.now() - 10 * 60_000)
  await fs.utimes(lock, long, long)
  const engine = start(home.path)
  expect(await engine.exited, await new Response(engine.stderr).text()).toBe(0)
  expect(existsSync(path.join(home.path, "cache", "old-0"))).toBe(false)
  expect(existsSync(lock)).toBe(false)
  expect(await fs.readFile(path.join(home.path, "cache", "version"), "utf8")).not.toBe("0")
}, 30_000)
