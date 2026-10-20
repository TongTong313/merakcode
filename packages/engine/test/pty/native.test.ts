import { describe, expect, test } from "vitest"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { runtime, tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"

const native = pathToFileURL(path.resolve(import.meta.dirname, "../../src/pty/native.ts")).href
const shell = process.platform === "win32" ? `["cmd.exe", ["/c", "echo pty-ok"]]` : `["/bin/sh", ["-c", "echo pty-ok"]]`

// Runs in a separate process because the point is whether the host exits on its own after the terminal program does.
// The script is written to a file: run via --eval on Windows, node-pty gets no output and the process never exits.
async function run(code: string) {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "pty.mjs")
  await Filesystem.write(file, code)
  // Must await inside the scope: the temp directory is removed when the scope ends
  return await Process.run([...runtime, file], { timeout: 15_000, nothrow: true })
}

const script = `
const { NativePty } = await import(${JSON.stringify(native)})
const [command, args] = ${shell}
const child = await NativePty.spawn(command, args, { cols: 100, rows: 30 })
let output = ""
child.onData((data) => (output += data))
child.onExit(({ exitCode }) => {
  child.kill()
  child.write("ignored")
  child.resize(80, 24)
  console.log(JSON.stringify({ exitCode, saw: output.includes("pty-ok") }))
})
`

describe("NativePty", () => {
  test("host exits on its own after the terminal program exits; later kill / write / resize do not throw", async () => {
    const started = Date.now()
    const result = await run(script)
    expect(result.stderr.toString()).toBe("")
    expect(JSON.parse(result.text().trim().split("\n").at(-1)!)).toEqual({ exitCode: 0, saw: true })
    expect(result.exitCode).toBe(0)
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 20_000)

  // node-pty's input pipe cannot be written under Bun ("Socket is closed"), so the backend depends on the runtime
  test("an interactive shell receives input and echoes the result", async () => {
    const interactive = process.platform === "win32" ? `["cmd.exe", []]` : `["/bin/sh", []]`
    const typed = `
const { NativePty } = await import(${JSON.stringify(native)})
const [command, args] = ${interactive}
const child = await NativePty.spawn(command, args, {})
let output = ""
child.onData((data) => (output += data))
setTimeout(() => child.write("echo typed-ok\\r"), 800)
setTimeout(() => {
  console.log("count=" + (output.split("typed-ok").length - 1))
  child.kill()
  setTimeout(() => process.exit(0), 300)
}, 4000)
`
    const result = await run(typed)
    // At least one input echo and one result; a terminal redraw may echo the input again
    expect(Number(result.text().match(/count=(\d+)/)?.[1])).toBeGreaterThanOrEqual(2)
  }, 20_000)

  // A user types right after opening a terminal and closes it at once: input queued before the terminal is ready
  // lands on a disconnected pipe after the close
  test("writing and killing right after spawn causes no uncaught error in the host", async () => {
    const interactive = process.platform === "win32" ? `["cmd.exe", []]` : `["/bin/sh", []]`
    const quick = `
const { NativePty } = await import(${JSON.stringify(native)})
process.on("uncaughtException", (error) => { console.log("uncaught: " + error.message); process.exit(1) })
const [command, args] = ${interactive}
const child = await NativePty.spawn(command, args, {})
child.onExit(() => setTimeout(() => { console.log("clean"); process.exit(0) }, 500))
child.write("echo AAA\\r")
child.kill()
`
    const result = await run(quick)
    expect(result.text()).toContain("clean")
    expect(result.text()).not.toContain("uncaught")
    expect(result.exitCode).toBe(0)
  }, 20_000)
})
