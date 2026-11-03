import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { Runtime } from "@merakcode/util/runtime"
import { runExternal, decideExternal } from "../../src/agent/external/runtime"
import { Instance } from "../../src/infra/project/instance"
import { Session } from "../../src/agent/session"
import { PermissionNext } from "../../src/agent/permission/next"
import { Bus } from "../../src/infra/bus"
import { tmpdir, selectPermissionLevel } from "../fixture/fixture"

test.each(["once", "reject"] as const)(
  "external operation start and finish honor a real %s decision",
  async (reply) => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const shown: PermissionNext.Request[] = []
        const off = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
          shown.push(event.properties)
          void PermissionNext.reply({
            requestID: event.properties.id,
            reply,
            decisionRevision: event.properties.decisionRevision,
          })
        })
        try {
          const result = await runExternal({
            runID: "operation-lifecycle",
            sessionID: session.id,
            launch: [
              process.execPath,
              ...Runtime.execArgv(),
              path.join(import.meta.dirname, "fixture/operation-adapter.ts"),
            ],
            product: { id: "operations", title: "Operations" },
            task: { prompt: "Write one controlled file", cwd: tmp.path, permissionLevel: "ask" },
            abort: new AbortController().signal,
            host: {
              step: () => {},
              permission: (request, operation) =>
                decideExternal(
                  { sessionID: session.id, executionID: "operation-lifecycle", cwd: tmp.path, operation },
                  request,
                ),
              question: async () => [],
            },
          })
          expect(result.text).toBe(reply === "once" ? "DONE" : "DENIED")
          expect(shown).toHaveLength(1)
          expect(shown[0]?.sandboxReady).toBe(false)
          if (reply === "once") {
            expect(await fs.readFile(path.join(tmp.path, "effect.txt"), "utf8")).toBe("CHANGED")
            expect(await fs.readFile(path.join(tmp.path, "finished"), "utf8")).toBe("FINISHED")
          } else await expect(fs.stat(path.join(tmp.path, "effect.txt"))).rejects.toMatchObject({ code: "ENOENT" })
          expect(await PermissionNext.list()).toEqual([])
        } finally {
          off()
        }
      },
    })
  },
  15000,
)

test("an unconfirmed external operation blocks a second task before dispatch", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await selectPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover" })
      const second = path.join(tmp.path, "second")
      await fs.mkdir(second)
      const controller = new AbortController()
      const run = (runID: string, cwd: string, prompt: string) =>
        runExternal({
          runID,
          sessionID: session.id,
          launch: [
            process.execPath,
            ...Runtime.execArgv(),
            path.join(import.meta.dirname, "fixture/operation-adapter.ts"),
          ],
          product: { id: "operations", title: "Operations" },
          task: { prompt, cwd, permissionLevel: "fullTakeover" },
          abort: controller.signal,
          host: {
            step: () => {},
            permission: (request, operation) =>
              decideExternal({ sessionID: session.id, executionID: runID, cwd, operation }, request),
            question: async () => [],
          },
        })
      const first = run("unconfirmed-first", tmp.path, "hold-unconfirmed")
      first.catch(() => {})
      try {
        await expect
          .poll(() => fs.readFile(path.join(tmp.path, "effect.txt"), "utf8").catch(() => ""), { timeout: 5000 })
          .not.toBe("")
        await expect(selectPermissionLevel({ sessionID: session.id, permissionLevel: "ask" })).rejects.toMatchObject({
          name: "ModeOperationPendingError",
        })
        await expect(run("blocked-second", second, "write")).rejects.toBeInstanceOf(Error)
        await expect(fs.stat(path.join(second, "task-received"))).rejects.toMatchObject({ code: "ENOENT" })
      } finally {
        controller.abort()
        await first.catch(() => {})
      }
    },
  })
}, 20000)

test.each([1, 2])(
  "tightening %d concurrent external operations waits for every real process receipt",
  async (count) => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await selectPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover" })
        const controller = new AbortController()
        const directories = await Promise.all(
          Array.from({ length: count }, async (_, index) => {
            const directory = path.join(tmp.path, String(index))
            await fs.mkdir(directory)
            return directory
          }),
        )
        const running = directories.map((directory, index) => {
          const runID = `operation-cancel-${index}`
          const result = runExternal({
            runID,
            sessionID: session.id,
            launch: [
              process.execPath,
              ...Runtime.execArgv(),
              path.join(import.meta.dirname, "fixture/operation-adapter.ts"),
            ],
            product: { id: "operations", title: "Operations" },
            task: { prompt: count === 1 ? "hold-completed" : "hold", cwd: directory, permissionLevel: "fullTakeover" },
            abort: controller.signal,
            host: {
              step: () => {},
              permission: (request, operation) =>
                decideExternal({ sessionID: session.id, executionID: runID, cwd: directory, operation }, request),
              question: async () => [],
            },
          })
          result.catch(() => {})
          return result
        })
        try {
          for (const directory of directories)
            await expect
              .poll(() => fs.readFile(path.join(directory, "effect.txt"), "utf8").catch(() => ""), { timeout: 5000 })
              .not.toBe("")
          const pids = await Promise.all(
            directories.map(async (directory) => Number(await fs.readFile(path.join(directory, "effect.txt"), "utf8"))),
          )
          await selectPermissionLevel({ sessionID: session.id, permissionLevel: "ask" })
          for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
          for (const result of running) await expect(result).rejects.toMatchObject({ name: "AbortError" })
          for (const directory of directories)
            expect(await fs.readFile(path.join(directory, "finished"), "utf8")).toBe("FINISHED")
        } finally {
          controller.abort()
          await Promise.allSettled(running)
        }
      },
    })
  },
  15000,
)
