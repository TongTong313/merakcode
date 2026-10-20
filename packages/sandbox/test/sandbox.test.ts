/**
 * The parts every backend shares: proxy registration, environment, git guard and the report. The backend here runs
 * the command without OS isolation; the isolation itself is covered by conformance.test.ts.
 */
import { afterEach, expect, test } from "vitest"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { Policy, Sandbox, type Backend } from "../src/index"

const roots: string[] = []
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

const direct: Backend = {
  status: async () => ({ status: "on" }),
  wrap: async (input) => ({ file: process.execPath, args: ["-e", input.command], env: input.env }),
}

async function target() {
  const server = http.createServer((_req, res) => res.end("target-ok"))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  closers.push(() => new Promise((resolve) => server.close(() => resolve())))
  return (server.address() as AddressInfo).port
}

function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "sandbox-facade-"))
  roots.push(dir)
  execFileSync("git", ["init", "--quiet", dir])
  return dir
}

function run(prepared: Sandbox.Prepared, cwd: string) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(prepared.file, prepared.args, { cwd, env: prepared.env, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    child.stdout.on("data", (chunk) => (out += chunk))
    child.stderr.on("data", (chunk) => (out += chunk))
    child.on("close", (code) => resolve({ code, out }))
  })
}

/** Node script for the command: GETs each URL through HTTP_PROXY and prints status codes */
const fetchAll = (urls: string[]) => `
const http = require("node:http")
const proxy = new URL(process.env.HTTP_PROXY)
const auth = "Basic " + Buffer.from(decodeURIComponent(proxy.username) + ":x").toString("base64")
const get = (url) => new Promise((resolve) => {
  http.get({ host: proxy.hostname, port: proxy.port, path: url, headers: { "proxy-authorization": auth } }, (res) => {
    res.resume(); res.on("end", () => resolve(res.statusCode))
  }).on("error", () => resolve(0))
})
;(async () => { for (const url of ${JSON.stringify(urls)}) console.log(url, await get(url)) })()
`

test("commands get the proxy and temp folder; questions name the command; the report lists refused hosts", async () => {
  const port = await target()
  const sandbox = Sandbox.create(direct, { lookup: async () => "127.0.0.1" })
  closers.push(() => sandbox.close())
  const cwd = workspace()
  const asked: string[] = []
  const policy = Policy.build({
    workspace: [cwd],
    home: tmpdir(),
    tmp: path.join(cwd, "tmp"),
    network: { allow: ["allowed.test"], deny: ["denied.test"] },
  })
  const prepared = await sandbox.prepare({
    command:
      fetchAll([`http://allowed.test:${port}/`, `http://new.test:${port}/`, `http://denied.test:${port}/`]) +
      "\nconsole.log('TEMP=' + process.env.TEMP)",
    shell: "node",
    cwd,
    env: { PATH: process.env.PATH, MERAKCODE_SERVER_PASSWORD: "secret" },
    policy,
    tmp: path.join(cwd, "tmp"),
    ask: async (req) => (asked.push(req.host), false),
  })
  expect(prepared.env.MERAKCODE_SERVER_PASSWORD).toBeUndefined()
  const result = await run(prepared, cwd)
  expect(result.out).toContain(`http://allowed.test:${port}/ 200`)
  expect(result.out).toContain(`http://new.test:${port}/ 403`)
  expect(result.out).toContain(`http://denied.test:${port}/ 403`)
  expect(result.out).toContain(`TEMP=${path.join(cwd, "tmp")}`)
  expect(asked).toEqual(["new.test"])
  const report = prepared.finish(result.out, result.code)
  expect(report).toContain("[MRK-5005]")
  expect(report).toContain("new.test, denied.test")
  expect(prepared.finish(result.out, result.code)).toBe("")
})

test("a git hook the command adds is removed and reported", async () => {
  const sandbox = Sandbox.create(direct)
  closers.push(() => sandbox.close())
  const cwd = workspace()
  const hook = path.join(cwd, ".git", "hooks", "pre-commit")
  const prepared = await sandbox.prepare({
    command: `require("node:fs").writeFileSync(${JSON.stringify(hook)}, "evil")`,
    shell: "node",
    cwd,
    env: { PATH: process.env.PATH },
    policy: Policy.build({ workspace: [cwd], home: tmpdir(), tmp: tmpdir() }),
    tmp: tmpdir(),
    ask: async () => false,
  })
  const result = await run(prepared, cwd)
  expect(existsSync(hook)).toBe(true)
  const report = prepared.finish(result.out, result.code)
  expect(existsSync(hook)).toBe(false)
  expect(report).toContain("pre-commit")
})
