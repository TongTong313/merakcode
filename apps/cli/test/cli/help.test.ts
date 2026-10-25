import { expect, test } from "vitest"
import path from "path"
import { Process } from "@merakcode/util/process"
import { runtime } from "../fixture/fixture"

const root = path.resolve(import.meta.dirname, "../..")

async function merak(args: string[]) {
  const proc = Process.spawn([...runtime, "src/index.ts", ...args], {
    cwd: root,
    env: {
      ...process.env,
      MERAKCODE_LOCALE: "en-US",
      MERAKCODE_DISABLE_CATALOG_FETCH: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => proc.kill(), 20_000)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => clearTimeout(timer))
  return { stdout, stderr, code }
}

test("help output names the merak command", async () => {
  const { stdout, stderr, code } = await merak(["--help"])
  expect(stderr).not.toContain("catalog refresh failed")
  expect(code).toBe(0)
  expect(stdout).toContain("merak completion")
  expect(stdout).toContain("merak serve")
  expect(stdout).not.toContain("merakcode completion")
})

test("merak without a command prints the help and exits without starting an engine", async () => {
  const { stdout, stderr, code } = await merak([])
  expect(code, stderr).toBe(0)
  expect(stdout).toContain("merak serve")
  expect(stdout).toContain("merak run")
})
