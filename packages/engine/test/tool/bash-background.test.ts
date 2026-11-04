import { afterEach, describe, expect, test } from "vitest"
import { spawn } from "child_process"
import { BashBackgroundTool, BashJobStore, looksLikePrompt } from "@merakcode/engine/agent/tools/bash-background"
import fs from "node:fs/promises"
import path from "node:path"
import { Instance } from "../../src/infra/project/instance"
import { Session } from "../../src/agent/session"
import { Shell } from "../../src/infra/process/shell/shell"
import { tmpdir } from "../fixture/fixture"
import { Process } from "@merakcode/util/process"
import { ModeOperations } from "../../src/agent/permission/operations"

function spawnSleep(seconds: number) {
  const cmd = process.platform === "win32" ? `ping -n ${seconds + 1} 127.0.0.1` : `sleep ${seconds}`
  return spawn(cmd, {
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  })
}

async function waitFor(check: () => boolean, timeoutMs = 4_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return check()
}

describe("BashJobStore", () => {
  afterEach(() => {
    BashJobStore.clear()
  })

  test("a background stop ends descendants after their original parent exits", async () => {
    await using tmp = await tmpdir()
    const effect = path.join(tmp.path, "effect")
    const pidFile = path.join(tmp.path, "worker.pid")
    const parentDone = path.join(tmp.path, "parent.done")
    const worker = path.join(tmp.path, "worker.cjs")
    const parent = path.join(tmp.path, "parent.cjs")
    await fs.writeFile(
      worker,
      `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => fs.appendFileSync(${JSON.stringify(effect)}, 'x'), 30); setTimeout(() => process.exit(), 15000)`,
    )
    await fs.writeFile(
      parent,
      `const fs = require('fs'); require('child_process').spawn(process.execPath, [${JSON.stringify(worker)}], {stdio:['ignore',1,2], detached:true}); fs.writeFileSync(${JSON.stringify(parentDone)}, 'done'); process.exit()`,
    )
    let workerPID: number | undefined
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const result = await (
            await BashBackgroundTool.init()
          ).execute(
            {
              command: `${Shell.quote(process.execPath.replaceAll("\\", "/"))} ${Shell.quote(parent.replaceAll("\\", "/"))}`,
              description: "Run a parent with a surviving worker",
            },
            {
              sessionID: session.id,
              messageID: "",
              callID: "",
              agent: "build",
              permissionLevel: "fullTakeover",
              abort: new AbortController().signal,
              messages: [],
              ruleset: [],
              metadata: () => {},
              ask: async () => {},
            },
          )
          await expect
            .poll(() =>
              fs.stat(effect).then(
                (s) => s.size,
                () => 0,
              ),
            )
            .toBeGreaterThan(0)
          workerPID = Number(await fs.readFile(pidFile, "utf8"))
          await fs.stat(parentDone)
          await new Promise((resolve) => setTimeout(resolve, 150))
          expect(await BashJobStore.stop(result.metadata.jobId)).toBe(true)
          expect(BashJobStore.get(result.metadata.jobId)?.status).toBe("stopped")
          const stoppedSize = (await fs.stat(effect)).size
          await new Promise((resolve) => setTimeout(resolve, 150))
          expect((await fs.stat(effect)).size).toBe(stoppedSize)
        },
      })
    } finally {
      if (workerPID) {
        if (process.platform === "win32")
          await Process.run(["taskkill", "/pid", String(workerPID), "/f", "/t"], { nothrow: true })
        else {
          try {
            process.kill(workerPID, "SIGKILL")
          } catch {}
        }
      }
      BashJobStore.clear()
    }
  }, 20000)

  test.skipIf(process.platform !== "win32")("a failed tree termination never reports a confirmed stop", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const proc = spawn(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true })
        const job = BashJobStore.create({
          command: "exit",
          description: "Unconfirmed stop",
          cwd: tmp.path,
          proc,
          sessionID: session.id,
        })
        await new Promise<void>((resolve) => proc.once("exit", () => resolve()))
        await expect(BashJobStore.stop(job.id)).rejects.toMatchObject({ name: "ModeOperationPendingError" })
        expect(job.status).toBe("running")
        expect(job.endedAt).toBeNull()
        expect(() => ModeOperations.assertAvailable(session.id)).toThrow()
        BashJobStore.finish(job.id, 0, "completed")
        expect(() => ModeOperations.assertAvailable(session.id)).not.toThrow()
      },
    })
  })

  test("a stop request wins over the process failure reported while cancellation settles", async () => {
    const proc = spawnSleep(60)
    const job = BashJobStore.create({ command: "sleep", description: "Stop ordering", cwd: process.cwd(), proc })
    const closed = new Promise<string>((resolve) =>
      proc.once("close", (code) => {
        BashJobStore.finish(job.id, code, "failed")
        resolve(job.status)
      }),
    )
    const stopping = BashJobStore.stop(job.id)
    await expect(closed).resolves.toBe("stopped")
    await stopping
  })

  test("create returns a running job and keeps it in the list", () => {
    const proc = spawnSleep(60)
    try {
      const job = BashJobStore.create({ command: "sleep 60", description: "test sleep", cwd: process.cwd(), proc })
      expect(job.status).toBe("running")
      expect(job.id).toMatch(/^job_/)
      expect(job.pid).toBe(proc.pid)
      expect(BashJobStore.get(job.id)).toBe(job)
      expect(BashJobStore.list().some((j) => j.id === job.id)).toBe(true)
    } finally {
      proc.kill()
    }
  })

  test("append stores logs and truncates past the buffer limit", () => {
    const proc = spawnSleep(60)
    try {
      const job = BashJobStore.create({ command: "sleep", description: "buf", cwd: process.cwd(), proc })
      BashJobStore.append(job.id, "hello")
      BashJobStore.append(job.id, " world")
      expect(job.log).toBe("hello world")

      BashJobStore.append(job.id, "x".repeat(600_000))
      expect(job.log.length).toBeLessThanOrEqual(500_000)
      expect(job.log.endsWith("x")).toBe(true)
    } finally {
      proc.kill()
    }
  })

  test("finish sets exit, status, and endedAt", () => {
    const proc = spawnSleep(60)
    try {
      const job = BashJobStore.create({ command: "x", description: "x", cwd: process.cwd(), proc })
      BashJobStore.finish(job.id, 0, "completed")
      expect(job.status).toBe("completed")
      expect(job.exitCode).toBe(0)
      expect(job.endedAt).not.toBeNull()
    } finally {
      proc.kill()
    }
  })

  test("stop returns false for missing or already finished jobs", async () => {
    expect(await BashJobStore.stop("job_nonexistent_xxxxxxxx")).toBe(false)

    const proc = spawnSleep(60)
    const job = BashJobStore.create({ command: "x", description: "x", cwd: process.cwd(), proc })
    BashJobStore.finish(job.id, 0, "completed")
    expect(await BashJobStore.stop(job.id)).toBe(false)
    proc.kill()
  })

  test("stop kills a running job process tree", async () => {
    const proc = spawnSleep(60)
    const job = BashJobStore.create({ command: "sleep 60", description: "x", cwd: process.cwd(), proc })

    // A signal kill on Linux and macOS leaves exitCode null and proc.killed false, so wait for the exit itself
    const exit = new Promise<boolean>((resolve) => proc.once("exit", () => resolve(true)))

    const ok = await BashJobStore.stop(job.id)
    expect(ok).toBe(true)
    expect(job.status).toBe("stopped")

    expect(await Promise.race([exit, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000))])).toBe(
      true,
    )
  }, 10_000)

  test("timeout stops a running background job", async () => {
    const proc = spawnSleep(60)
    const job = BashJobStore.create({
      command: "sleep 60",
      description: "timeout",
      cwd: process.cwd(),
      proc,
      timeoutMs: 50,
    })

    expect(await waitFor(() => job.status === "stopped")).toBe(true)
    expect(job.log).toContain("exceeding timeout")
  }, 5_000)

  test("looksLikePrompt detects common interactive prompts", () => {
    expect(looksLikePrompt("Overwrite?")).toBe(true)
    expect(looksLikePrompt("Are you sure?")).toBe(true)
    expect(looksLikePrompt("build completed")).toBe(false)
  })

  test("stopAll terminates all running background jobs", async () => {
    const first = spawnSleep(60)
    const second = spawnSleep(60)
    const firstJob = BashJobStore.create({ command: "sleep 60", description: "first", cwd: process.cwd(), proc: first })
    const secondJob = BashJobStore.create({
      command: "sleep 60",
      description: "second",
      cwd: process.cwd(),
      proc: second,
    })

    await BashJobStore.stopAll()

    expect(firstJob.status).toBe("stopped")
    expect(secondJob.status).toBe("stopped")
    expect(BashJobStore.running()).toHaveLength(0)
  }, 10_000)
})
