import { afterEach, expect, test } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Policy } from "../policy"
import { LinuxSandbox } from "./index"
import { SandboxRequest } from "./request"

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

test("a release starts the bundled helper next to the engine bundle", () => {
  const lib = mkdtempSync(path.join(tmpdir(), "lib-"))
  roots.push(lib)
  writeFileSync(path.join(lib, "sandbox-linux.js"), "")
  const here = pathToFileURL(path.join(lib, "main.js")).href
  expect(LinuxSandbox.helper(here, ["--import", "file:///loader.mjs"])).toEqual([
    process.execPath,
    "--disable-warning=ExperimentalWarning",
    path.join(lib, "sandbox-linux.js"),
  ])
})

test("development starts the TypeScript helper with the same loader as the engine", () => {
  const src = mkdtempSync(path.join(tmpdir(), "src-"))
  roots.push(src)
  const here = pathToFileURL(path.join(src, "index.ts")).href
  expect(LinuxSandbox.helper(here, ["--import", "file:///loader.mjs"])).toEqual([
    process.execPath,
    "--import",
    "file:///loader.mjs",
    "--disable-warning=ExperimentalWarning",
    path.join(src, "exec.ts"),
  ])
})

test("the helper is started with the request file and a digest of its content", async () => {
  const work = mkdtempSync(path.join(tmpdir(), "work-"))
  roots.push(work)
  const launch = await LinuxSandbox.create().wrap({
    command: "echo hi",
    shell: "/bin/sh",
    cwd: work,
    env: { PATH: "/usr/bin" },
    policy: Policy.build({ workspace: [work], home: tmpdir(), tmp: tmpdir() }),
    proxyPort: 1234,
  })
  try {
    const [file, digest] = launch.args.slice(-2)
    const content = readFileSync(file!)
    expect(SandboxRequest.matches(content, digest!)).toBe(true)
    expect(JSON.parse(content.toString("utf8"))).toMatchObject({ command: "echo hi", ports: [1234] })
    expect(SandboxRequest.matches(Buffer.from(content.toString("utf8").replace("echo hi", "echo no")), digest!)).toBe(
      false,
    )
  } finally {
    launch.cleanup?.()
  }
})

test("Landlock is reported unavailable off Linux", async () => {
  if (process.platform === "linux") return
  expect(LinuxSandbox.abi()).toBe(0)
  expect(await LinuxSandbox.create().status()).toMatchObject({ status: "unsupported" })
})
