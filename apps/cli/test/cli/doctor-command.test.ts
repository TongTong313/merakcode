/**
 * merak doctor: runs every check even when an early one fails, prints a code and advice for each failure,
 * and exits 1 when something failed.
 */
import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { Process } from "@merakcode/util/process"
import { cli, tmpdir } from "../fixture/fixture"

type Check = { id: string; status: "pass" | "warn" | "fail" | "skip"; code?: string; hint?: string; detail: string }

// Without provider keys from the developer's machine, so "no model connected" is predictable
const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/_API_KEY$/.test(key)))

async function doctor(cwd: string, env: Record<string, string>, ...args: string[]) {
  const proc = Process.spawn([...cli, "doctor", ...args], {
    cwd,
    env: { ...base, MERAKCODE_LOCALE: "en", ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
}

test("a broken global config fails with MRK-3001 and the later checks still run", { timeout: 120_000 }, async () => {
  await using tmp = await tmpdir()
  const config = path.join(tmp.path, "config")
  await fs.mkdir(path.join(config, "merakcode"), { recursive: true })
  await fs.writeFile(path.join(config, "merakcode", "merakcode.json"), '{ "model": ')

  const result = await doctor(tmp.path, { XDG_CONFIG_HOME: config }, "--json")
  expect(result.code).toBe(1)
  const checks = JSON.parse(result.stdout) as Check[]
  const ids = checks.map((check) => check.id)
  expect(ids).toEqual(["version", "system", "config", "engine", "providers", "sandbox", "ripgrep", "logs"])
  const broken = checks.find((check) => check.id === "config")!
  expect(broken).toMatchObject({ status: "fail", code: "MRK-3001" })
  expect(broken.detail).toContain("merakcode.json")
  expect(broken.hint).toBeTruthy()
  expect(checks.find((check) => check.id === "logs")!.status).toBe("pass")
})

test("a healthy setup passes; no connected model is only a warning", { timeout: 120_000 }, async () => {
  await using tmp = await tmpdir()
  const result = await doctor(tmp.path, {})
  expect(result.code, result.stdout + result.stderr).toBe(0)
  expect(result.stdout).toContain("[MRK-2007]")
  expect(result.stdout).toContain("Connect a model provider in /provider first.")
  expect(result.stdout).toContain("Engine")
  expect(result.stdout).not.toContain("✗")
})
