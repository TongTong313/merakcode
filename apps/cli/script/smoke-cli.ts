import path from "path"
import os from "os"
import fs from "fs/promises"
import { spawnSync } from "node:child_process"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"
import { Project } from "@merakcode/util/project"

// Smoke gate for the release package: minimal checks on the build.ts output (the bin/merak launcher).
// Makes sure statically and dynamically imported chunks resolve after bundling, --help/--version of each command
// succeed, debug startup runs, and a serve instance answers HTTP. With MERAKCODE_SMOKE_MODEL=1 it also calls a real
// model (a model must be configured).
//
// Usage (repo root; on Windows point MERAKCODE_SMOKE_BIN at bin\merak.cmd):
//   MERAKCODE_SMOKE_BIN=<package>/bin/merak node --import ./script/node/register.mjs apps/cli/script/smoke-cli.ts
// Local runs and CI share this gate: any failed check exits non-zero; when all pass it exits 0 at once and never hangs.

// The binary path comes from the environment (it must be absolute; the script builds no platform-specific paths).
const bin = process.env.MERAKCODE_SMOKE_BIN
if (!bin) {
  process.stderr.write(
    "✗ MERAKCODE_SMOKE_BIN is not set (it should be the absolute path of bin/merak in the package)\n",
  )
  process.exit(1)
}

// Stops a started command. On Windows bin is merak.cmd and the real process is the node it starts: ending only cmd.exe
// would leave node running in the background
function stop(proc: Process.Child) {
  if (process.platform !== "win32") return void proc.kill()
  spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
}

// Timeout for ordinary commands (--help and the like return within seconds; generous margin to catch hangs).
const DEFAULT_TIMEOUT = 30_000
// Timeout for the real model call: models can be slow.
const MODEL_TIMEOUT = 180_000

type RunResult = { code: number; out: string; err: string; timedOut: boolean }

// Runs a quick command that exits on its own via Process.run: nothrow returns the exit code instead of throwing, and
// output is collected rather than passed through (we decide what to print). stdin is ignored (like /dev/null) so the
// command cannot mistake the parent's TTY for interactive input.
// The timeout only stops waiting and does not kill the child, so use this only for commands that should return within
// seconds. The race timer must be cleared, or it keeps the event loop alive and the script hangs.
async function run(args: string[], timeout: number): Promise<RunResult> {
  const proc = Process.run([bin!, ...args], { nothrow: true })
  let timer: ReturnType<typeof setTimeout>
  const timed = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeout)
  })
  const result = await Promise.race([proc, timed])
  clearTimeout(timer!)
  if (result === "timeout") return { code: 124, out: "", err: `timed out (>${timeout}ms)`, timedOut: true }
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString(), timedOut: false }
}

// Runs a possibly long command (such as a real model call) via Process.spawn: on timeout it ends the process tree and
// awaits the exit, so no orphan is left. Every race timer is cleared so it cannot keep the event loop alive.
async function spawn(args: string[], timeout: number): Promise<RunResult> {
  const proc = Process.spawn([bin!, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  // Read while running: otherwise the output fills the pipe buffer and the child blocks on write
  const out = new Response(proc.stdout).text()
  const err = new Response(proc.stderr).text()
  let timer: ReturnType<typeof setTimeout>
  let timedOut = false
  const timed = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      stop(proc)
      resolve("timeout")
    }, timeout)
  })
  await Promise.race([proc.exited, timed])
  clearTimeout(timer!)
  // After a timeout the kill was already sent; wait for the actual exit so the child is reaped.
  const code = await proc.exited
  return { code, out: await out, err: await err, timedOut }
}

// Collected failures decide the exit code at the end.
const failures: string[] = []

function ok(label: string) {
  process.stdout.write(`✓ ${label}\n`)
}

function fail(label: string, detail: string) {
  failures.push(label)
  process.stdout.write(`✗ ${label}: ${detail}\n`)
}

async function waitForServerUrl(proc: Process.Child, timeout: number) {
  const reader = proc.stdout!.getReader()
  const decoder = new TextDecoder()
  let output = ""
  let timer: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeout)
  })

  try {
    while (true) {
      const result = await Promise.race([reader.read(), timeoutPromise])
      if (result === "timeout") return undefined
      if (result.done) return undefined
      output += decoder.decode(result.value, { stream: true })
      const match = /MerakCode server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)
      if (match) return match[1]
    }
  } finally {
    clearTimeout(timer!)
    reader.releaseLock()
  }
}

async function expectHttpStatus(label: string, url: string, status: number, init?: RequestInit) {
  const response = await fetch(url, init).catch((error) => error as Error)
  if (response instanceof Error) {
    fail(label, response.message)
    return undefined
  }
  if (response.status !== status) {
    fail(label, `HTTP ${response.status}, expected ${status}`)
    return undefined
  }
  ok(label)
  return response
}

async function smokeServer() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "merakcode-smoke-"))
  const project = path.join(tmp, "project")
  await fs.mkdir(project, { recursive: true })
  await Filesystem.write(
    path.join(project, "merakcode.json"),
    JSON.stringify({ $schema: `https://raw.githubusercontent.com/${Project.REPOSITORY}/main/schema/config.json` }),
  )

  const proc = Process.spawn([bin!, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      MERAKCODE_TEST_HOME: path.join(tmp, "home"),
      MERAKCODE_HOME: path.join(tmp, "merakcode"),
      MERAKCODE_DISABLE_MODELS_FETCH: "1",
      MERAKCODE_DISABLE_CONFIG_WATCH: "1",
      MERAKCODE_DISABLE_SKILL_WATCH: "1",
    },
  })

  try {
    const base = await waitForServerUrl(proc, DEFAULT_TIMEOUT)
    if (!base) {
      const err = await new Response(proc.stderr).text()
      fail("server start", err.trim() || "no listening address found in the output")
      return
    }
    ok("server start")

    await expectHttpStatus("OpenAPI", `${base}/doc`, 200)
    await expectHttpStatus("health", `${base}/global/health`, 200)

    await expectHttpStatus("tool ids", `${base}/experimental/tool/ids`, 200)
    const directory = encodeURIComponent(project)
    await expectHttpStatus("provider refresh", `${base}/provider/refresh?directory=${directory}`, 200, {
      method: "POST",
    })
    await expectHttpStatus("provider list", `${base}/provider?directory=${directory}`, 200)
  } finally {
    stop(proc)
    await proc.exited.catch(() => {})
    // On Windows the engine's database files stay locked for a moment after its process tree is killed
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

// 1. No command: prints the help listing the commands and exits on its own
const dflt = await run([], DEFAULT_TIMEOUT)
if (dflt.code !== 0) {
  fail("default ([]) prints the help", `exit code ${dflt.code} ${dflt.err.trim()}`)
} else if (!dflt.out.includes(" serve")) {
  fail("default ([]) prints the help", "the output does not list the serve command")
} else {
  ok("default ([]) prints the help")
}

// 2. Basic commands: --help, --version and the like must succeed
const basics: { label: string; args: string[] }[] = [
  { label: "--help", args: ["--help"] },
  { label: "--version", args: ["--version"] },
  { label: "run --help", args: ["run", "--help"] },
  { label: "debug --help", args: ["debug", "--help"] },
  { label: "mcp --help", args: ["mcp", "--help"] },
  { label: "serve --help", args: ["serve", "--help"] },
  { label: "agent --help", args: ["agent", "--help"] },
  { label: "upgrade --help", args: ["upgrade", "--help"] },
]

for (const item of basics) {
  const r = await run(item.args, DEFAULT_TIMEOUT)
  if (r.code !== 0) {
    fail(item.label, `exit code ${r.code} ${r.err.trim()}`)
    continue
  }
  ok(item.label)
}

// 3. debug startup: exit code 0 proves every bundled dynamic chunk resolves; prints the startup time
const startup = await run(["debug", "startup"], DEFAULT_TIMEOUT)
if (startup.code !== 0) {
  fail("debug startup", `exit code ${startup.code} ${startup.err.trim()}`)
} else {
  ok(`debug startup (started in ${startup.out.trim()} ms)`)
}

// 4. serve: the HTTP API is available
await smokeServer()

// 5. SDK client: management commands start the engine and send requests through the SDK, so the SDK client's
// dependencies must load after bundling
const sessions = await run(["session", "list", "--format", "json"], DEFAULT_TIMEOUT)
if (sessions.code !== 0) {
  fail("session list (via SDK)", `exit code ${sessions.code} ${(sessions.err || sessions.out).trim()}`)
} else {
  ok("session list (via SDK)")
}

if (process.env.MERAKCODE_SMOKE_MODEL === "1") {
  // 6. Real model call: run "say hi" --format json, end to end.
  // spawn lets a timeout reap the process. Passes only with exit code 0 and a valid JSON event stream (every line
  // parses, at least one line).
  const MODEL_LABEL = 'run "say hi" --format json (real model)'
  const model = await spawn(["run", "say hi", "--format", "json"], MODEL_TIMEOUT)
  if (model.code !== 0) {
    fail(MODEL_LABEL, model.timedOut ? model.err : `exit code ${model.code} ${(model.err || model.out).trim()}`)
  } else {
    // --format json prints NDJSON (one JSON event per line); check that every line parses.
    const lines = model.out.split("\n").filter((line) => line.trim().length > 0)
    const bad = lines.find((line) => {
      try {
        JSON.parse(line)
        return false
      } catch {
        return true
      }
    })
    if (lines.length === 0) {
      fail(MODEL_LABEL, "exit code 0 but no output (no JSON events received)")
    } else if (bad !== undefined) {
      fail(MODEL_LABEL, `invalid JSON line in the output: ${bad.slice(0, 120)}`)
    } else {
      ok(`${MODEL_LABEL}: ${lines.length} JSON events`)
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`\n✗ smoke failed: ${failures.length} check(s) (${failures.join(", ")})\n`)
  process.exit(1)
}

process.stdout.write("\nAll smoke checks passed\n")
// Exit explicitly: end at once even if handles or timers remain, so a successful run cannot hang (CI would see a hang).
process.exit(0)
