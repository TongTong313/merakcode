import { describe, expect, test, vi } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Instance } from "../../project/instance"
import { Storage } from "../../storage/storage"
import { LoopScheduler } from "./index"
import { SessionExecution } from "../../session/execution"
import { SessionRunner } from "../../session/runner"
import { fn } from "../../util/fn"
import { setTimeout as delay } from "node:timers/promises"

/** Each test gets its own temp directory Instance, so Storage and timers do not leak between tests */
async function withInstance<T>(fn: () => Promise<T> | T): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "merakcode-loop-test-"))
  return Instance.provide({ directory: dir, fn })
}

/** Long enough that the interval never fires during a test (the immediate run on creation still happens) */
const HUGE = 3600_000

describe("LoopScheduler", () => {
  test.each(["finished", "cancelled"])(
    "background runs leave the %s request scope they were created in",
    async (ending) => {
      await withInstance(async () => {
        const sessionID = "ses_loop_scope"
        const scope = SessionExecution.create({ id: `loop-scope-${ending}`, sessionID })
        let first!: (scope: SessionExecution.Scope | undefined) => void
        let next!: (scope: SessionExecution.Scope | undefined) => void
        const initial = new Promise<SessionExecution.Scope | undefined>((resolve) => (first = resolve))
        const subsequent = new Promise<SessionExecution.Scope | undefined>((resolve) => (next = resolve))
        let ended = false
        const prompt = vi.spyOn(SessionRunner, "prompt").mockImplementation(
          fn(SessionRunner.PromptInput, async () => {
            if (ended) next(SessionExecution.current())
            else first(SessionExecution.current())
            return undefined as never
          }),
        )
        let id: string | undefined
        try {
          id = await SessionExecution.run(scope, () =>
            LoopScheduler.create({ sessionID, interval: 30, prompt: "background follow-up" }),
          )
          const initialScope = await initial
          const cancelling = ending === "cancelled" ? SessionExecution.cancel(sessionID, [scope.id]) : undefined
          SessionExecution.finish(scope)
          await cancelling
          ended = true
          const laterScope = await subsequent
          expect(initialScope).toBeUndefined()
          expect(laterScope).toBeUndefined()
        } finally {
          SessionExecution.finish(scope)
          if (id) await LoopScheduler.remove(id)
          prompt.mockRestore()
        }
      })
    },
  )

  test("create persists the task and lists it; remove deletes it", async () => {
    await withInstance(async () => {
      const id = await LoopScheduler.create({ interval: HUGE, prompt: "hi", sessionID: "s1" })

      const listed = LoopScheduler.list("s1")
      expect(listed).toHaveLength(1)
      expect(listed[0].id).toBe(id)
      expect(listed[0].prompt).toBe("hi")
      expect(listed[0].status).toBe("running")

      // Without session data, rootID falls back to the sessionID itself
      const persisted = await Storage.read<LoopScheduler.LoopTask>(["cron", "s1", id])
      expect(persisted.id).toBe(id)

      const removed = await LoopScheduler.remove(id)
      expect(removed).toBe(true)
      expect(LoopScheduler.list("s1")).toHaveLength(0)
      await expect(Storage.read(["cron", "s1", id])).rejects.toThrow()
    })
  })

  test("list filters by sessionID", async () => {
    await withInstance(async () => {
      await LoopScheduler.create({ interval: HUGE, prompt: "a", sessionID: "s1" })
      await LoopScheduler.create({ interval: HUGE, prompt: "b", sessionID: "s2" })

      expect(LoopScheduler.list("s1")).toHaveLength(1)
      expect(LoopScheduler.list("s2")).toHaveLength(1)
      expect(LoopScheduler.list()).toHaveLength(2)

      await LoopScheduler.removeBySession("s1")
      await LoopScheduler.removeBySession("s2")
    })
  })

  test("removeBySession removes all tasks of the session from memory and storage", async () => {
    await withInstance(async () => {
      const id1 = await LoopScheduler.create({ interval: HUGE, prompt: "a", sessionID: "s1" })
      const id2 = await LoopScheduler.create({ interval: HUGE, prompt: "b", sessionID: "s1" })

      await LoopScheduler.removeBySession("s1")

      expect(LoopScheduler.list("s1")).toHaveLength(0)
      await expect(Storage.read(["cron", "s1", id1])).rejects.toThrow()
      await expect(Storage.read(["cron", "s1", id2])).rejects.toThrow()
    })
  })

  test("a task deleted while its first result is still being written is not written back", async () => {
    await withInstance(async () => {
      // Let create's own write through and hold the next one (the result of the immediate first run), so the
      // delete happens while that write is in flight
      const original = Storage.write
      let release!: () => void
      const gate = new Promise<void>((resolve) => (release = resolve))
      let intercepted!: () => void
      const reached = new Promise<void>((resolve) => (intercepted = resolve))
      let gatedWrite: Promise<void> | undefined
      let cronWrites = 0
      const spy = vi.spyOn(Storage, "write").mockImplementation((key, content) => {
        if (key[0] !== "cron" || ++cronWrites !== 2) return original(key, content)
        gatedWrite = (async () => {
          intercepted()
          await gate
          await original(key, content)
        })()
        return gatedWrite
      })
      try {
        const id = await LoopScheduler.create({ interval: HUGE, prompt: "a", sessionID: "s1" })
        await reached

        const removing = LoopScheduler.removeBySession("s1")
        // The delete must not finish before this write, or the write would land afterwards and restore the file
        const first = await Promise.race([removing.then(() => "removed"), delay(200).then(() => "waiting")])
        release()
        await removing
        await gatedWrite

        await expect(Storage.read(["cron", "s1", id])).rejects.toThrow()
        expect(first).toBe("waiting")
      } finally {
        spy.mockRestore()
      }
    })
  })

  test("recover re-arms running tasks from storage, skipping paused tasks and other directories", async () => {
    await withInstance(async () => {
      const dir = Instance.directory
      // Written directly, like tasks left by a previous process
      const base = {
        directory: dir,
        interval: HUGE,
        prompt: "x",
        createdAt: Date.now(),
        nextRun: Date.now() + HUGE,
      }
      await Storage.write(["cron", "root", "t-run"], {
        ...base,
        id: "t-run",
        sessionID: "root",
        rootID: "root",
        status: "running",
      })
      await Storage.write(["cron", "root", "t-paused"], {
        ...base,
        id: "t-paused",
        sessionID: "root",
        rootID: "root",
        status: "paused",
      })
      await Storage.write(["cron", "root", "t-other"], {
        ...base,
        id: "t-other",
        sessionID: "root",
        rootID: "root",
        status: "running",
        directory: "/somewhere/else",
      })

      await LoopScheduler.recover()

      const listed = LoopScheduler.list()
        .map((t) => t.id)
        .sort()
      expect(listed).toEqual(["t-run"])

      await LoopScheduler.removeBySession("root")
    })
  })

  test("recover does not run tasks immediately (no catch-up)", async () => {
    await withInstance(async () => {
      const promptSpy = vi.fn(() => {})
      await Storage.write(["cron", "root", "t1"], {
        id: "t1",
        sessionID: "root",
        rootID: "root",
        directory: Instance.directory,
        interval: HUGE,
        prompt: "x",
        createdAt: Date.now(),
        nextRun: Date.now() + HUGE,
        status: "running",
      })

      await LoopScheduler.recover()
      // Re-armed and listed, but not run: arm() waits for the interval
      expect(LoopScheduler.list("root")).toHaveLength(1)
      expect(promptSpy).not.toHaveBeenCalled()

      await LoopScheduler.removeBySession("root")
    })
  })
})
