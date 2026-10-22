import { expect, test } from "vitest"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Storage } from "../../src/storage/storage"
import { evaluate, tmpdir, runtime } from "../fixture/fixture"
import { Process } from "@merakcode/util/process"
import { setTimeout as delay } from "node:timers/promises"

type Value = { id: string; revision: number; payload: string }

function spawn(cwd: string, key: string[], mode?: string) {
  const child = Process.spawn(
    [...runtime, path.join(import.meta.dirname, "storage-multiprocess-fixture.ts"), JSON.stringify(key), mode ?? ""],
    {
      cwd,
      env: { ...process.env, NODE_OPTIONS: "" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const errors = new Response(child.stderr).text()
  const ready = child
    .stdout!.getReader()
    .read()
    .then((chunk) => expect(new TextDecoder().decode(chunk.value).trim()).toBe("ready"))
  return { child, errors, ready }
}

test("another process never reads a partial record during Storage.write or update", async () => {
  await using tmp = await tmpdir()
  const key = ["diagnostic", `multiprocess-${crypto.randomUUID()}`]
  const value = { id: "session-fixture", revision: 0, payload: "x".repeat(512 * 1024) }
  await Storage.write(key, value)
  const { child, errors, ready } = spawn(tmp.path, key)
  const timer = setTimeout(() => child.kill(), 20_000)
  const failures: Array<{ name: string; code?: string }> = []
  let reads = 0
  try {
    await ready
    child.stdin!.write("go\n")
    while (child.exitCode === null) {
      await Storage.read<Value>(key).then(
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
    expect((await Storage.read<Value>(key)).revision).toBe(60)
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill()
    await child.exited
    await Storage.remove(key)
  }
}, 30_000)

// Setting WAL on a database another process was creating or recovering failed as busy without waiting, so one of two
// engines started together (the desktop app and the command line) could not open the database at all
test("processes opening a new database at the same time all get to write", async () => {
  const db = pathToFileURL(path.join(import.meta.dirname, "../../src/storage/db.ts")).href
  const code = `const { Database } = await import(${JSON.stringify(db)})
Database.transaction(() => Database.query("INSERT INTO record (key, data) VALUES (?, ?)").run(process.argv[1], "x"))
Database.close()`
  for (let round = 0; round < 8; round++) {
    await using home = await tmpdir()
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        Process.run([...evaluate(code), `writer-${index}`], {
          env: { ...process.env, MERAKCODE_HOME: home.path },
          nothrow: true,
        }),
      ),
    )
    for (const result of results) expect(result.exitCode, result.stderr.toString()).toBe(0)
  }
}, 120_000)

test("updates from several processes at once never lose each other's change", async () => {
  await using tmp = await tmpdir()
  const key = ["diagnostic", `increment-${crypto.randomUUID()}`]
  await Storage.write(key, { id: "counter", revision: 0, payload: "" })
  const workers = [spawn(tmp.path, key, "increment"), spawn(tmp.path, key, "increment")]
  try {
    await Promise.all(workers.map((worker) => worker.ready))
    for (const worker of workers) worker.child.stdin!.write("go\n")
    for (let index = 0; index < 40; index++)
      await Storage.update<Value>(key, (draft) => {
        draft.revision++
      })
    for (const worker of workers) expect(await worker.child.exited, await worker.errors).toBe(0)
    expect((await Storage.read<Value>(key)).revision).toBe(120)
  } finally {
    for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill()
    await Storage.remove(key)
  }
}, 30_000)
