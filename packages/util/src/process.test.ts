import { afterAll, beforeAll, describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Process } from "./process"

// Run inline scripts with the current runtime so the tests do not depend on installed commands
const node = (code: string) => [process.execPath, "-e", code]

let root = ""

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "process-test-")))
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe("Process.spawn", () => {
  test("pipes stdout as a web stream and resolves the exit code", async () => {
    const child = Process.spawn(node("process.stdout.write('hi'); process.exit(3)"), { stderr: "ignore" })
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    expect(text).toBe("hi")
    expect(code).toBe(3)
    expect(child.exitCode).toBe(3)
  })

  test("writes to a piped stdin", async () => {
    const child = Process.spawn(
      node("process.stdin.on('data', (d) => process.stdout.write(String(d).toUpperCase()))"),
      {
        stdin: "pipe",
      },
    )
    child.stdin!.write("abc")
    child.stdin!.end()
    expect(await new Response(child.stdout).text()).toBe("ABC")
  })

  test("runs in the given directory with the given environment", async () => {
    const child = Process.spawn(node("process.stdout.write(process.cwd() + '|' + process.env.PROBE)"), {
      cwd: root,
      env: { ...process.env, PROBE: "yes" },
    })
    expect(await new Response(child.stdout).text()).toBe(`${root}|yes`)
  })

  // Like Bun.spawn: piped output is drained even when nobody reads it yet, so the child never blocks on a full pipe
  test("does not block a child whose piped output is read only after it exits", async () => {
    const child = Process.spawn(node("process.stdout.write('x'.repeat(2_000_000))"))
    const code = await Promise.race([
      child.exited,
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 5_000)),
    ])
    expect(code).toBe(0)
    expect((await new Response(child.stdout).text()).length).toBe(2_000_000)
  }, 10_000)

  test("throws ENOENT right away for a command that does not exist", () => {
    expect(() => Process.spawn(["no-such-command-merakcode"])).toThrow(expect.objectContaining({ code: "ENOENT" }))
  })

  test("a spawn failure (missing cwd) rejects exited for whoever awaits it, without an unhandled rejection", async () => {
    const unhandled: unknown[] = []
    const track = (reason: unknown) => unhandled.push(reason)
    process.on("unhandledRejection", track)
    try {
      const child = Process.spawn([process.execPath, "-e", "0"], { cwd: path.join(os.tmpdir(), `gone-${Date.now()}`) })
      await new Promise((resolve) => setTimeout(resolve, 200))
      await expect(child.exited).rejects.toMatchObject({ code: "ENOENT" })
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", track)
    }
  })

  test("reports 128 + signal number after kill, like a shell", async () => {
    const child = Process.spawn(node("setInterval(() => {}, 1000)"))
    child.kill()
    expect(await child.exited).toBe(143)
  })

  test("kills the child when the abort signal fires", async () => {
    const abort = new AbortController()
    const child = Process.spawn(node("setInterval(() => {}, 1000)"), { signal: abort.signal })
    abort.abort()
    expect(await child.exited).toBe(143)
  })
})

describe("Process.run", () => {
  test("collects stdout and stderr", async () => {
    const result = await Process.run(node("process.stdout.write('out'); process.stderr.write('err')"))
    expect(result.exitCode).toBe(0)
    expect(result.text()).toBe("out")
    expect(result.stderr.toString()).toBe("err")
  })

  test("throws on a non-zero exit with the output attached", async () => {
    const error = await Process.run(node("process.stderr.write('bad'); process.exit(2)")).catch((caught) => caught)
    expect(error).toBeInstanceOf(Process.RunError)
    expect(error.exitCode).toBe(2)
    expect(error.stderr.toString()).toBe("bad")
  })

  test("returns the failed result instead of throwing with nothrow", async () => {
    const result = await Process.run(node("process.exit(4)"), { nothrow: true })
    expect(result.exitCode).toBe(4)
  })

  test("feeds the given input to stdin", async () => {
    const result = await Process.run(node("process.stdin.pipe(process.stdout)"), { stdin: "piped input" })
    expect(result.text()).toBe("piped input")
  })

  test("turns a missing command into a failed result with nothrow", async () => {
    const result = await Process.run(["no-such-command-merakcode"], { nothrow: true })
    expect(result.exitCode).not.toBe(0)
  })
})

describe("Process.which", () => {
  test("finds a command on PATH and returns its absolute path", async () => {
    const name = process.platform === "win32" ? "probe-tool.cmd" : "probe-tool"
    await fs.writeFile(path.join(root, name), process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n", {
      mode: 0o755,
    })
    expect(Process.which("probe-tool", { PATH: root })).toBe(path.join(root, name))
  })

  test("returns null when the command is missing", () => {
    expect(Process.which("no-such-command-merakcode")).toBeNull()
  })

  test("resolves an explicit relative path against cwd", async () => {
    const name = process.platform === "win32" ? "local-tool.cmd" : "local-tool"
    await fs.writeFile(path.join(root, name), "", { mode: 0o755 })
    expect(Process.which(`./${name}`, { cwd: root })).toBe(path.join(root, name))
  })
})
