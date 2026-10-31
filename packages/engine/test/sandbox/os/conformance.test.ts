/**
 * The same checks against the sandbox of whatever system this runs on. Skipped, with the reason printed, when the
 * sandbox is not on (e.g. Windows before `merak sandbox setup`). CI turns it on for all three systems.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { Sandbox, type Status } from "../../../src/infra/sandbox/index"

const backend = Sandbox.backend(SandboxPolicy.base(os.homedir()))
const status: Status = await backend.status()
if (status.status !== "on" && process.env.MERAKCODE_SANDBOX_REQUIRED)
  throw new Error(`The sandbox must be on here but is ${status.status}: ${status.reason}`)
if (status.status !== "on") console.log(`sandbox conformance skipped: ${status.reason ?? status.status}`)

const windows = process.platform === "win32"
const shell = windows ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh"

describe.skipIf(status.status !== "on")(`sandbox conformance (${status.backend})`, () => {
  // Windows keeps approved account permissions: the engine normally allows the whole system temp directory.
  // Put its fixture outside that allowed tree so the negative write check exercises an actual denied location.
  const root = mkdtempSync(path.join(windows ? os.homedir() : os.tmpdir(), "sandbox-conformance-"))
  const work = path.join(root, "work")
  const home = path.join(root, "home")
  const tmp = path.join(root, "tmp")
  const outside = path.join(home, "outside")
  const secret = path.join(home, "secret")
  let server: http.Server
  let port = 0
  let engine: http.Server
  let enginePort = 0
  const sandbox = Sandbox.create(backend, { lookup: async (host) => (host.endsWith(".test") ? "127.0.0.1" : host) })

  beforeAll(async () => {
    for (const dir of [work, outside, secret, tmp]) mkdirSync(dir, { recursive: true })
    execFileSync("git", ["init", "--quiet", work])
    writeFileSync(path.join(secret, "key.txt"), "SECRET-CONTENT\n")
    writeFileSync(path.join(outside, "note.txt"), "readable note\n")
    server = http.createServer((_req, res) => res.end("target-ok"))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    port = (server.address() as AddressInfo).port
    engine = http.createServer((req, res) => {
      res.statusCode = req.headers.authorization === "Basic right" ? 200 : 401
      res.end("engine")
    })
    await new Promise<void>((resolve) => engine.listen(0, "127.0.0.1", resolve))
    enginePort = (engine.address() as AddressInfo).port
  })

  afterAll(async () => {
    await sandbox.close()
    server?.close()
    engine?.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  })

  const policy = () =>
    SandboxPolicy.build({
      workspace: [work],
      home,
      tmp,
      readDeny: [secret],
      network: { allow: ["allowed.test"], deny: ["denied.test"], blockPorts: [enginePort] },
    })

  async function run(command: string, options: { onStart?: (pid: number) => void } = {}) {
    const prepared = await sandbox.prepare({
      command,
      shell,
      cwd: work,
      env: process.env,
      policy: policy(),
      tmp,
      ask: async () => false,
    })
    return new Promise<{ code: number | null; stdout: Buffer; stderr: Buffer; report: string }>((resolve) => {
      const child = spawn(prepared.file, prepared.args, {
        cwd: work,
        env: prepared.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: !windows,
      })
      options.onStart?.(child.pid!)
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
      child.on("close", (code) => {
        const out = Buffer.concat(stdout)
        const err = Buffer.concat(stderr)
        resolve({ code, stdout: out, stderr: err, report: prepared.finish(out.toString() + err.toString(), code) })
      })
    })
  }

  /** Writes a Node script into the workspace and returns the command that runs it */
  function node(name: string, source: string, args: string[] = []) {
    writeFileSync(path.join(work, name), source)
    return [`"${process.execPath}"`, name, ...args.map((arg) => `"${arg}"`)].join(" ")
  }

  const fetchScript = (url: string) => `
const http = require("node:http")
const proxy = new URL(process.env.HTTP_PROXY)
const auth = "Basic " + Buffer.from(decodeURIComponent(proxy.username) + ":x").toString("base64")
http.get({ host: proxy.hostname, port: proxy.port, path: ${JSON.stringify(url)}, headers: { "proxy-authorization": auth } }, (res) => {
  let body = ""; res.on("data", (c) => body += c); res.on("end", () => console.log(res.statusCode, body))
}).on("error", (e) => console.log("error", e.message))`

  test("1 writes in the workspace", async () => {
    const result = await run(node("w.js", `require("fs").writeFileSync("inside.txt", "x")`))
    expect(result.code, result.stderr.toString()).toBe(0)
    expect(existsSync(path.join(work, "inside.txt"))).toBe(true)
  })

  test("2 cannot write outside the allowed folders", async () => {
    const target = path.join(outside, "written.txt")
    const result = await run(
      node(
        "o.js",
        `try { require("fs").writeFileSync(${JSON.stringify(target)}, "x") } catch (e) { console.log(e.code) }`,
      ),
    )
    expect(result.code, result.stderr.toString()).toBe(0)
    expect(result.stdout.toString()).toMatch(/EACCES|EPERM/)
    expect(existsSync(target)).toBe(false)
  })

  test("3 cannot read a denied folder", async () => {
    const result = await run(
      node(
        "r.js",
        `try { console.log(require("fs").readFileSync(${JSON.stringify(path.join(secret, "key.txt"))}, "utf8")) } catch (e) { console.log(e.code) }`,
      ),
    )
    expect(result.stdout.toString()).not.toContain("SECRET-CONTENT")
  })

  test("4 reads an ordinary file outside the workspace", async () => {
    const result = await run(
      node(
        "n.js",
        `console.log(require("fs").readFileSync(${JSON.stringify(path.join(outside, "note.txt"))}, "utf8"))`,
      ),
    )
    expect(result.stdout.toString()).toContain("readable note")
  })

  test("5 reaches an allowed host through the proxy", async () => {
    const result = await run(node("a.js", fetchScript(`http://allowed.test:${port}/`)))
    expect(result.stdout.toString()).toContain("200 target-ok")
  })

  test("6 a denied host fails with an explanation", async () => {
    const result = await run(node("d.js", fetchScript(`http://denied.test:${port}/`)))
    expect(result.stdout.toString()).toContain("403 blocked by MerakCode sandbox: denied.test")
    expect(result.report).toContain("denied.test")
  })

  test("8 cannot use the engine's API", async () => {
    const direct = await run(
      node(
        "e.js",
        `require("http").get("http://127.0.0.1:${enginePort}/", (res) => console.log(res.statusCode)).on("error", (e) => console.log(e.code))`,
      ),
    )
    expect(direct.stdout.toString()).not.toMatch(/^200/m)
    const proxied = await run(node("p.js", fetchScript(`http://127.0.0.1:${enginePort}/`)))
    expect(proxied.stdout.toString()).toMatch(/^403/m)
  })

  test("9 a git hook cannot be added, or is rolled back and reported", async () => {
    const hook = path.join(work, ".git", "hooks", "pre-commit")
    const result = await run(
      node(
        "h.js",
        `try { require("fs").writeFileSync(${JSON.stringify(hook)}, "evil") } catch (e) { console.log(e.code) }`,
      ),
    )
    expect(existsSync(hook)).toBe(false)
    if (!/EPERM|EACCES/.test(result.stdout.toString())) expect(result.report).toContain("pre-commit")
  })

  test("10 stopping the command ends its whole process tree", async () => {
    const pidFile = path.join(work, "child.pid")
    rmSync(pidFile, { force: true })
    let launched = 0
    const running = run(
      node(
        "t.js",
        `const c = require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" }); require("fs").writeFileSync("child.pid", String(c.pid)); setTimeout(() => {}, 60000)`,
      ),
      { onStart: (pid) => (launched = pid) },
    )
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await sleep(100)
    const grandchild = Number(readFileSync(pidFile, "utf8"))
    if (windows) process.kill(launched)
    else process.kill(-launched, "SIGKILL")
    await running
    await sleep(1000)
    const alive = (() => {
      try {
        process.kill(grandchild, 0)
        return true
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM"
      }
    })()
    expect(alive).toBe(false)
  })

  test("11 exit code, UTF-8 output and arguments come back unchanged", async () => {
    const result = await run(
      node(
        "u.js",
        `process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n你好\\n"); process.stderr.write("错误\\n"); process.exit(7)`,
        ["a b", "中文"],
      ),
    )
    expect(result.code).toBe(7)
    expect(result.stdout.toString("utf8")).toBe('["a b","中文"]\n你好\n')
    expect(result.stderr.toString("utf8")).toBe("错误\n")
  })

  test("12 everyday tools work", async () => {
    for (const command of ["git --version", "git status --short", `"${process.execPath}" -e "console.log(1)"`]) {
      const result = await run(command)
      expect(result.code, `${command}: ${result.stderr.toString()}`).toBe(0)
    }
    const result = await run(
      node(
        "tmp.js",
        `require("fs").writeFileSync(require("path").join(require("os").tmpdir(), "t.txt"), "x"); console.log("ok")`,
      ),
    )
    expect(result.stdout.toString()).toContain("ok")
  })
})

import { SandboxPolicy } from "../../../src/agent/permission/sandbox-policy"
