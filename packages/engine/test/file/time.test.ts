import { describe, expect, test } from "vitest"
import { FileTime } from "@merakcode/engine/file/time"
import { Instance } from "@merakcode/engine/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"
import { setTimeout as delay } from "node:timers/promises"
import { utimes } from "node:fs/promises"

// withLock and acquireBarrier are the only per-file concurrency guards for parallel tool calls. These tests run real
// concurrent tasks without mocks.

describe("FileTime.withLock", () => {
  test("serializes concurrent calls on the same file without interleaving", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = `${tmp.path}/a.txt`
        const trace: string[] = []
        const task = (tag: string) =>
          FileTime.withLock(file, async () => {
            trace.push(`${tag}:enter`)
            await delay(10)
            trace.push(`${tag}:exit`)
          })
        await Promise.all([task("a"), task("b"), task("c")])
        expect(trace).toEqual(["a:enter", "a:exit", "b:enter", "b:exit", "c:enter", "c:exit"])
      },
    })
  })

  test("concurrent read-modify-write on the same file loses none of 20 increments", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = `${tmp.path}/counter.txt`
        await Filesystem.write(file, "0")
        const inc = () =>
          FileTime.withLock(file, async () => {
            const n = Number(await Filesystem.readText(file))
            // Widens the read-to-write window so updates would be lost without the lock
            await delay(1)
            await Filesystem.write(file, String(n + 1))
          })
        await Promise.all(Array.from({ length: 20 }, inc))
        expect(await Filesystem.readText(file)).toBe("20")
      },
    })
  })

  test("calls on different files run concurrently without blocking each other", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const trace: string[] = []
        const task = (tag: string) =>
          FileTime.withLock(`${tmp.path}/${tag}.txt`, async () => {
            trace.push(`${tag}:enter`)
            await delay(20)
            trace.push(`${tag}:exit`)
          })
        await Promise.all([task("a"), task("b")])
        // Truly parallel: both enters happen before any exit
        expect(trace.slice(0, 2).sort()).toEqual(["a:enter", "b:enter"])
      },
    })
  })

  test("releases the lock when the callback throws so later writes are not blocked", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = `${tmp.path}/a.txt`
        await expect(
          FileTime.withLock(file, async () => {
            throw new Error("boom")
          }),
        ).rejects.toThrow("boom")
        let ran = false
        await FileTime.withLock(file, async () => {
          ran = true
        })
        expect(ran).toBe(true)
      },
    })
  })

  test("released locks do not leak in the map", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = `${tmp.path}/a.txt`
        await FileTime.withLock(file, async () => {})
        expect(FileTime.state().locks.has(file)).toBe(false)
      },
    })
  })
})

describe("FileTime.acquireBarrier", () => {
  test("file writes queue while the barrier is held and run after release", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const trace: string[] = []
        const release = await FileTime.acquireBarrier()
        trace.push("barrier:up")
        const write = FileTime.withLock(`${tmp.path}/a.txt`, async () => {
          trace.push("write:run")
        })
        await delay(20)
        expect(trace).toEqual(["barrier:up"])
        release()
        await write
        expect(trace).toEqual(["barrier:up", "write:run"])
      },
    })
  })

  test("barrier is acquired only after in-flight file writes finish", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const trace: string[] = []
        const write = FileTime.withLock(`${tmp.path}/a.txt`, async () => {
          trace.push("write:enter")
          await delay(30)
          trace.push("write:exit")
        })
        await delay(5)
        const release = await FileTime.acquireBarrier()
        trace.push("barrier:acquired")
        release()
        await write
        expect(trace).toEqual(["write:enter", "write:exit", "barrier:acquired"])
      },
    })
  })

  test("two barriers are mutually exclusive", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const trace: string[] = []
        const first = await FileTime.acquireBarrier()
        const second = FileTime.acquireBarrier().then((release) => {
          trace.push("second:acquired")
          release()
        })
        await delay(20)
        expect(trace).toEqual([])
        first()
        await second
        expect(trace).toEqual(["second:acquired"])
      },
    })
  })

  test("release is idempotent and a repeated call does not release a later barrier", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const release = await FileTime.acquireBarrier()
        release()
        release()
        const next = await FileTime.acquireBarrier()
        // If the repeated release cleared the new barrier, this file write would run early
        let ran = false
        const write = FileTime.withLock(`${tmp.path}/a.txt`, async () => {
          ran = true
        })
        await delay(10)
        expect(ran).toBe(false)
        next()
        await write
        expect(ran).toBe(true)
      },
    })
  })
})

describe("FileTime.assert", () => {
  // The filesystem mtime can be later than the system time read right after it (different clock precision, 1ms on
  // Windows). Writing right after a read must not be mistaken for a change by someone else.
  test("no conflict when the mtime is already ahead of the current time at read", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = `${tmp.path}/a.txt`
        await Filesystem.write(file, "a")
        const ahead = new Date(Date.now() + 2000)
        await utimes(file, ahead, ahead)
        FileTime.read("session", file)
        await expect(FileTime.assert("session", file)).resolves.toBeUndefined()
      },
    })
  })

  test("reports a conflict when the file changed after the read", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = `${tmp.path}/a.txt`
        await Filesystem.write(file, "a")
        FileTime.read("session", file)
        const later = new Date(Date.now() + 2000)
        await utimes(file, later, later)
        await expect(FileTime.assert("session", file)).rejects.toThrow("has been modified since it was last read")
      },
    })
  })
})
