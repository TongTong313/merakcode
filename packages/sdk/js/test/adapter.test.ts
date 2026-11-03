import { expect, test } from "vitest"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { bundle, declarations } from "../script/adapter-library"

const run = promisify(execFile)

test.each(["ask", "autoApprove", "fullTakeover"])(
  "standalone host checks actual operation coverage for %s",
  async (permissionLevel) => {
    await using space = await workspace(`import {adapter} from "./merakcode-adapter.mjs"
    import fs from "node:fs/promises"
    adapter({inspect:()=>({name:"Opaque fixture"}),run:async()=>{await fs.writeFile("effect","CHANGED");return{text:"DONE"}}})`)
    const execution = run(
      process.execPath,
      [
        "merakcode-adapter.mjs",
        "test",
        "--permission-level",
        permissionLevel,
        "--",
        process.execPath,
        "adapter.mts",
        "Write one file",
      ],
      { cwd: space.dir },
    )
    if (permissionLevel === "fullTakeover") {
      expect((await execution).stdout).toContain("result DONE")
      expect(await fs.readFile(path.join(space.dir, "effect"), "utf8")).toBe("CHANGED")
      return
    }
    await expect(execution).rejects.toMatchObject({ stderr: expect.stringContaining("MRK-4009") })
    await expect(fs.stat(path.join(space.dir, "effect"))).rejects.toMatchObject({ code: "ENOENT" })
  },
  30000,
)

test("the standalone SDK host exercises operation start and finish through a real adapter", async () => {
  await using space = await workspace(`import {adapter} from "./merakcode-adapter.mjs"
    import fs from "node:fs/promises"
    adapter({inspect:()=>({name:"Operation self-test",capabilities:{modelSelection:false,modelDiscovery:false,textStreaming:false,resume:false,permission:"merak",questions:false,control:{reportedOperations:["read","write","command","network","tool"],cancellation:"task",liveMode:false,limitations:[]}}}),run:async(task,host)=>{
      const decision=await host.operationStart({id:"one",request:{kind:"write",paths:["effect"]},isolation:"none"})
      if(!decision.allow)return{text:"DENIED"}
      decision.signal.throwIfAborted();await fs.writeFile("effect","CHANGED")
      await host.operationFinish({id:"one",status:"completed"});return{text:"DONE"}
    }})`)
  const result = await run(
    process.execPath,
    ["merakcode-adapter.mjs", "test", "--", process.execPath, "adapter.mts", "Write one controlled file"],
    { cwd: space.dir },
  )
  expect(result.stdout).toContain("operation/start one")
  expect(result.stdout).toContain("operation/finish one completed")
  expect(result.stdout).toContain("result DONE")
  expect(await fs.readFile(path.join(space.dir, "effect"), "utf8")).toBe("CHANGED")
}, 30000)

test("adapter rejects tasks before a valid handshake and validates live permission parameters", async () => {
  const { spawn } = await import("node:child_process")
  const readline = await import("node:readline")
  const { connect } = await import("../src/adapter/index")
  await using space = await workspace(`import {adapter} from "./merakcode-adapter.mjs"
    import fs from "node:fs/promises"
    adapter({inspect: () => ({name: "Validation fixture"}), run: async task => {await fs.writeFile("effect", "ran");return {text: task.permissionLevel}}})`)
  const child = spawn(process.execPath, ["adapter.mts"], { cwd: space.dir, stdio: ["pipe", "pipe", "inherit"] })
  const rpc = connect({
    lines: readline.createInterface({ input: child.stdout }),
    send: (line) => child.stdin.write(line + "\n"),
    handlers: {},
  })
  const task = { prompt: "Go", cwd: space.dir, permissionLevel: "ask" }
  try {
    await expect(rpc.request("initialize", { protocol: 2, product: { id: "old", title: "Old" } })).rejects.toThrow()
    await expect(rpc.request("task/run", task)).rejects.toThrow(/initializ|handshake/i)
    await rpc.request("initialize", { protocol: 3, product: { id: "new", title: "New" } })
    await expect(rpc.request("task/run", { ...task, permissionLevel: "fullAccess" })).rejects.toThrow()
    await expect(rpc.request("task/run", { ...task, scope: "execute" })).rejects.toThrow()
    await expect(rpc.request("task/permission-level", { permissionLevel: "auto", revision: 1 })).rejects.toThrow()
    await expect(rpc.request("task/permission-level", { permissionLevel: "ask", revision: "2" })).rejects.toThrow()
    await expect(fs.stat(path.join(space.dir, "effect"))).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    child.stdin.end()
    await rpc.closed
  }
}, 30_000)

test("permission level updates preserve the newest root revision in protocol 3", async () => {
  const { spawn } = await import("node:child_process")
  const readline = await import("node:readline")
  const { connect } = await import("../src/adapter/index")
  await using space = await workspace(`import {adapter} from "./merakcode-adapter.mjs"
    adapter({inspect: () => ({name: "Permission fixture"}), run: async task => ({text: task.permissionLevel})})`)
  const child = spawn(process.execPath, ["adapter.mts"], { cwd: space.dir, stdio: ["pipe", "pipe", "inherit"] })
  const rpc = connect({
    lines: readline.createInterface({ input: child.stdout }),
    send: (line) => child.stdin.write(line + "\n"),
    handlers: {},
  })
  try {
    await rpc.request("initialize", { protocol: 3, product: { id: "level", title: "Level" } })
    await rpc.request("task/permission-level", { permissionLevel: "autoApprove", revision: 2 })
    await rpc.request("task/permission-level", { permissionLevel: "fullTakeover", revision: 1 })
    expect(await rpc.request("task/run", { prompt: "Go", cwd: space.dir, permissionLevel: "ask" })).toMatchObject({
      text: "autoApprove",
    })
  } finally {
    child.stdin.end()
    await rpc.closed
  }
}, 30_000)

/** The single-file library, its types and an adapter written with them, in a fresh directory removed after the test */
async function workspace(adapter: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "merakcode-adapter 中文 space-"))
  await fs.writeFile(path.join(dir, "merakcode-adapter.mjs"), await bundle())
  await fs.writeFile(path.join(dir, "merakcode-adapter.d.mts"), await declarations())
  await fs.writeFile(path.join(dir, "adapter.mts"), adapter)
  return { dir, [Symbol.asyncDispose]: () => fs.rm(dir, { recursive: true, force: true }) }
}

const ADAPTER = `import { adapter } from "./merakcode-adapter.mjs"
adapter({
  inspect: () => ({ name: "Demo", version: "2.0.0" }),
  async run(task, host) {
    host.step({ tool: "shell", detail: "npm test" })
    const verdict = await host.permission({ kind: "command", command: "npm test" })
    const [answer] = await host.question([{ question: "Which?", header: "Pick", options: [{ label: "A", description: "" }, { label: "B", description: "" }] }])
    return { text: task.prompt + " " + verdict.allow + " " + answer.join(","), sessionId: "s1" }
  },
})
`

test("check runs the handshake only and prints what the adapter reports", async () => {
  await using space = await workspace(ADAPTER)
  const { stdout } = await run(
    process.execPath,
    ["merakcode-adapter.mjs", "check", "--", process.execPath, "adapter.mts"],
    {
      cwd: space.dir,
    },
  )
  expect(stdout).toContain("Demo")
  expect(stdout).toContain("2.0.0")
}, 30_000)

test("spawn from the library starts a CLI installed by npm, a .cmd shim on Windows, with its arguments unchanged", async () => {
  await using space = await workspace(`import { adapter, spawn } from "./merakcode-adapter.mjs"
adapter({
  inspect: () => ({ name: "Demo" }),
  async run(task) {
    const cli = spawn("democli", ["two words", 'say "hi"'], { cwd: task.cwd, stdio: ["ignore", "pipe", "inherit"] })
    let out = ""
    for await (const chunk of cli.stdout) out += chunk
    return { text: out }
  },
})
`)
  // Where npm puts a CLI: a shim named after it that starts the real script with node
  const bin = path.join(space.dir, "bin")
  await fs.mkdir(bin)
  const script = path.join(bin, "democli.js")
  await fs.writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))")
  if (process.platform === "win32") await fs.writeFile(path.join(bin, "democli.cmd"), `@node "%~dp0democli.js" %*\r\n`)
  else
    await fs.writeFile(path.join(bin, "democli"), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, {
      mode: 0o755,
    })
  const { stdout } = await run(
    process.execPath,
    [
      "merakcode-adapter.mjs",
      "test",
      "--permission-level",
      "fullTakeover",
      "--",
      process.execPath,
      "adapter.mts",
      "go",
    ],
    { cwd: space.dir, env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } },
  )
  expect(stdout).toContain(`result ${JSON.stringify(["two words", 'say "hi"'])}`)
}, 30_000)

/** A command named name on PATH as npm installs one: a shim (a .cmd on Windows) that starts the script with node */
async function npmCommand(dir: string, name: string, script: string) {
  const bin = path.join(dir, "bin")
  await fs.mkdir(bin, { recursive: true })
  const file = path.join(bin, `${name}.js`)
  await fs.writeFile(file, script)
  if (process.platform === "win32") await fs.writeFile(path.join(bin, `${name}.cmd`), `@node "%~dp0${name}.js" %*\r\n`)
  else
    await fs.writeFile(path.join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${file}" "$@"\n`, { mode: 0o755 })
  return bin
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test("stop ends a CLI with what it started, as the CLI behind an npm shim, and resolves once it is gone", async () => {
  const { spawn, stop } = await import("../src/adapter")
  await using space = await workspace("")
  const pidFile = path.join(space.dir, "cli.pid")
  // The CLI starts a process of its own (a language server, a shell): that one must go too
  const bin = await npmCommand(
    space.dir,
    "busycli",
    [
      `const { spawn } = require("child_process")`,
      `const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })`,
      `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(worker.pid))`,
      `setInterval(() => {}, 1000)`,
    ].join("\n"),
  )
  const child = spawn("busycli", [], {
    stdio: ["pipe", "ignore", "inherit"],
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH },
  })
  await expect
    .poll(
      () =>
        fs.access(pidFile).then(
          () => true,
          () => false,
        ),
      { timeout: 10_000 },
    )
    .toBe(true)
  const pid = Number(await fs.readFile(pidFile, "utf8"))
  await stop(child)
  await expect.poll(() => alive(pid), { timeout: 5_000, interval: 100 }).toBe(false)
}, 30_000)

test("version gives the first line a CLI prints for --version, or why it gives none", async () => {
  const { version } = await import("../src/adapter")
  await using space = await workspace("")
  const answers = await npmCommand(space.dir, "goodcli", `console.log("goodcli 1.2.3\\nbuilt today")`)
  const failing = await npmCommand(space.dir, "badcli", `console.error("no license"); process.exit(3)`)
  const PATH = [answers, failing, process.env.PATH].join(path.delimiter)
  const saved = process.env.PATH
  process.env.PATH = PATH
  try {
    expect(await version("goodcli")).toEqual({ version: "goodcli 1.2.3" })
    expect(await version("badcli")).toEqual({ unavailable: "no license" })
    expect(await version("missingcli")).toEqual({ unavailable: "missingcli is not installed" })
  } finally {
    process.env.PATH = saved
  }
}, 30_000)

test("a CLI that hangs on --version is given up on within seconds, and does not stay behind", async () => {
  const { version } = await import("../src/adapter")
  await using space = await workspace("")
  const pidFile = path.join(space.dir, "stuck.pid")
  const bin = await npmCommand(
    space.dir,
    "stuckcli",
    `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
  )
  const saved = process.env.PATH
  process.env.PATH = bin + path.delimiter + saved
  const started = Date.now()
  const result = await version("stuckcli").finally(() => (process.env.PATH = saved))
  expect(result).toEqual({ unavailable: "stuckcli --version did not answer within 5s" })
  expect(Date.now() - started).toBeLessThan(10_000)
  await expect.poll(async () => alive(Number(await fs.readFile(pidFile, "utf8"))), { timeout: 5_000 }).toBe(false)
}, 30_000)

test("test runs one task, allowing every request and picking the first option, and prints what happened", async () => {
  await using space = await workspace(ADAPTER)
  const { stdout } = await run(
    process.execPath,
    [
      "merakcode-adapter.mjs",
      "test",
      "--permission-level",
      "fullTakeover",
      "--",
      process.execPath,
      "adapter.mts",
      "do it",
    ],
    { cwd: space.dir },
  )
  expect(stdout).toContain("step shell npm test")
  expect(stdout).toContain('permission {"kind":"command","command":"npm test"}')
  expect(stdout).toContain("question Which?")
  expect(stdout).toContain("result do it true A")
  expect(stdout).toContain("session s1")
}, 30_000)

/** Type-checks a file with strict settings, as an editor does; resolves to the compiler's errors, empty when none */
async function typecheck(dir: string, file: string) {
  const tsc = path.join(import.meta.dirname, "..", "node_modules", "typescript", "bin", "tsc")
  const types = path.join(import.meta.dirname, "..", "node_modules", "@types")
  const args = [tsc, "--noEmit", "--strict", "--skipLibCheck", "--module", "nodenext", "--target", "esnext"]
  return run(process.execPath, [...args, "--typeRoots", types, "--types", "node", file], { cwd: dir }).then(
    () => "",
    (error: { stdout: string }) => error.stdout,
  )
}

test("the library's type declarations let a TypeScript adapter be checked, and catch a wrong call", async () => {
  await using space = await workspace(`import { adapter, spawn, stop, type Host } from "./merakcode-adapter.mjs"

/** host passed on to a helper of the adapter's own, typed with Host */
async function ask(host: Host, command: string) {
  return (await host.permission({ kind: "command", command })).allow
}

adapter({
  inspect: () => ({ name: "Typed", version: "1.0.0" }),
  async run(task, host) {
    const cli = spawn("mycli", [task.prompt], { cwd: task.cwd })
    task.signal.addEventListener("abort", () => void stop(cli))
    host.step({ tool: "shell", detail: "npm test" })
    return { text: String(await ask(host, "npm test")), sessionId: task.resume }
  },
})
`)
  expect(await typecheck(space.dir, "adapter.mts")).toBe("")
  await fs.writeFile(
    path.join(space.dir, "wrong.mts"),
    `import { adapter } from "./merakcode-adapter.mjs"
adapter({
  inspect: () => ({ name: "Wrong" }),
  async run(task, host) {
    host.step({ tool: 1 })
    return { text: "" }
  },
})
`,
  )
  expect(await typecheck(space.dir, "wrong.mts")).toContain("Type 'number' is not assignable to type 'string'")
}, 60_000)
