import { afterEach, describe, expect, test } from "vitest"
import { spawn } from "child_process"
import { BashJobStore, looksLikePrompt } from "@merakcode/engine/tool/bash-background"

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

    const exit = new Promise<number | null>((resolve) => {
      proc.once("exit", (code) => resolve(code))
    })

    const ok = await BashJobStore.stop(job.id)
    expect(ok).toBe(true)
    expect(job.status).toBe("stopped")

    await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 3000))])
    expect(proc.killed || proc.exitCode !== null).toBe(true)
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
