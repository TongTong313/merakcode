import { expect, test } from "vitest"
import { LogQueue } from "./queue"

test("offline queue is bounded and synchronous transport errors do not escape", async () => {
  const queue = new LogQueue<number>()
  for (let i = 0; i < 1000; i++) queue.write(i)
  expect(queue.dropped).toBe(900)
  const received: number[] = []
  const done = Promise.withResolvers<void>()
  const stop = queue.configure(async (item) => {
    received.push(item)
    if (received.length === 100) done.resolve()
  })
  await done.promise
  expect(received[0]).toBe(900)
  stop()
  queue.configure(() => {
    throw new Error("offline")
  })
  expect(() => queue.write(1001)).not.toThrow()
})

test("changing backend never forwards pending records to a different server", async () => {
  const queue = new LogQueue<string>()
  const gate = Promise.withResolvers<void>()
  const first: string[] = []
  const stop = queue.configure(async (item) => {
    first.push(item)
    await gate.promise
  })
  queue.write("old-in-flight")
  queue.write("old-pending")
  await Promise.resolve()
  stop()
  const next: string[] = []
  const done = Promise.withResolvers<void>()
  queue.configure(async (item) => {
    next.push(item)
    done.resolve()
  })
  queue.write("new")
  gate.resolve()
  await done.promise
  expect(first).toEqual(["old-in-flight"])
  expect(next).toEqual(["new"])
  expect(queue.dropped).toBe(1)
})
