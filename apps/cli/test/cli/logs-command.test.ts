/**
 * merak logs: reads the log directory (MERAKCODE_LOG_ROOT) without starting the engine.
 */
import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { Process } from "@merakcode/util/process"
import { cli, tmpdir } from "../fixture/fixture"

async function run(dir: string, folder: string, name: string, id: string, seconds: number, messages: string[]) {
  const target = path.join(dir, "production", folder)
  await fs.mkdir(target, { recursive: true })
  const file = path.join(target, `${name}--2026-10-20T00-00-0${seconds}-000Z--${100 + seconds}--${id}.ndjson`)
  const lines = messages.map((message, index) =>
    JSON.stringify({
      schema: "merakcode.log.v1",
      timestamp: `2026-10-20T00:00:0${index}.000Z`,
      level: "INFO",
      component: folder,
      service: "test",
      message,
      run_id: id,
      sequence: index + 1,
      pid: 100 + seconds,
    }),
  )
  await fs.writeFile(file, lines.join("\n") + "\n")
  await fs.utimes(file, seconds, seconds)
}

function merak(cwd: string, root: string, ...args: string[]) {
  return Process.spawn([...cli, "logs", ...args], {
    cwd,
    env: { ...process.env, MERAKCODE_LOCALE: "en", MERAKCODE_LOG_ROOT: root },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
}

async function output(proc: ReturnType<typeof merak>) {
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
}

async function fixture() {
  const tmp = await tmpdir()
  const root = path.join(tmp.path, "log")
  await run(root, "cli", "main", "cli-run-1", 1, ["cli started", "cli finished"])
  await run(root, "server", "backend", "server-run-2", 2, ["server started", "request completed"])
  return Object.assign(tmp, { root })
}

test("without options: says where the logs are and lists recent runs", { timeout: 60_000 }, async () => {
  await using tmp = await fixture()
  const result = await output(merak(tmp.path, tmp.root))
  expect(result.code, result.stderr).toBe(0)
  expect(result.stdout).toContain(tmp.root)
  expect(result.stdout).toContain("cli-run-1")
  expect(result.stdout).toContain("server-run-2")
  expect(result.stdout.indexOf("server-run-2")).toBeLessThan(result.stdout.indexOf("cli-run-1"))
})

test("--component keeps only that part of the product", { timeout: 60_000 }, async () => {
  await using tmp = await fixture()
  const result = await output(merak(tmp.path, tmp.root, "--component", "server"))
  expect(result.stdout).toContain("server-run-2")
  expect(result.stdout).not.toContain("cli-run-1")
})

test("--run prints only that run's records; a prefix of the id is enough", { timeout: 60_000 }, async () => {
  await using tmp = await fixture()
  const result = await output(merak(tmp.path, tmp.root, "--run", "cli-run", "--json"))
  expect(result.code, result.stderr).toBe(0)
  const records = JSON.parse(result.stdout) as { message: string; run_id: string }[]
  expect(records.map((record) => record.message)).toEqual(["cli started", "cli finished"])
})

test("--run with an unknown id fails and says so", { timeout: 60_000 }, async () => {
  await using tmp = await fixture()
  const result = await output(merak(tmp.path, tmp.root, "--run", "nope"))
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("nope")
})

/** A later record of server-run-2, as one line without the newline */
const later = (message: string) =>
  JSON.stringify({
    schema: "merakcode.log.v1",
    timestamp: "2026-10-20T00:00:09.000Z",
    level: "WARN",
    component: "server",
    service: "test",
    message,
    run_id: "server-run-2",
    sequence: 3,
    pid: 102,
  })

async function serverFile(root: string) {
  const dir = path.join(root, "production", "server")
  return path.join(dir, (await fs.readdir(dir))[0]!)
}

/** Reads a running command's output; on a timeout says what it printed and which log files it could see */
function reading(proc: ReturnType<typeof merak>, root: string) {
  const reader = proc.stdout!.getReader()
  let text = ""
  let errors = ""
  void (async () => {
    const stderr = proc.stderr!.getReader()
    for (let chunk = await stderr.read(); !chunk.done; chunk = await stderr.read())
      errors += new TextDecoder().decode(chunk.value)
  })()
  const until = async (expected: string, ms: number) => {
    const deadline = Date.now() + ms
    while (!text.includes(expected) && Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), delay(deadline - Date.now()).then(() => undefined)])
      if (!chunk || chunk.done) break
      text += new TextDecoder().decode(chunk.value)
    }
    const files = await fs.readdir(root, { recursive: true }).catch(() => [])
    expect(text, `stderr:\n${errors}\nfiles:\n${files.join("\n")}`).toContain(expected)
  }
  return { until, text: () => text }
}

test("--tail prints the last lines of the newest run and keeps following it", { timeout: 60_000 }, async () => {
  await using tmp = await fixture()
  const proc = merak(tmp.path, tmp.root, "--tail", "1")
  try {
    const output = reading(proc, tmp.root)
    await output.until("request completed", 40_000)
    expect(output.text()).not.toContain("server started")
    await fs.appendFile(await serverFile(tmp.root), later("appended later") + "\n")
    await output.until("appended later", 15_000)
  } finally {
    proc.kill()
    await proc.exited
  }
})

// Following started where the file ended when it was read again, after the last lines were printed: a line written in
// between was skipped, and so was a line still half written (on macOS CI the gap was long enough to lose a line)
test(
  "--tail prints a line that was half written when it started, once it is complete",
  { timeout: 60_000 },
  async () => {
    await using tmp = await fixture()
    const file = await serverFile(tmp.root)
    const line = later("written in two parts")
    await fs.appendFile(file, line.slice(0, 40))
    const proc = merak(tmp.path, tmp.root, "--tail", "1")
    try {
      const output = reading(proc, tmp.root)
      await output.until("request completed", 40_000)
      await fs.appendFile(file, line.slice(40) + "\n")
      await output.until("written in two parts", 15_000)
    } finally {
      proc.kill()
      await proc.exited
    }
  },
)
