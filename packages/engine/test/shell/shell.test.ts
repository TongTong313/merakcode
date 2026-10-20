import { describe, expect, test } from "vitest"
import { Shell } from "../../src/shell/shell"
import { tmpdir } from "../fixture/fixture"

describe("Shell.run", () => {
  test("runs a whole command line in the bash tool's shell, with pipes and &&", async () => {
    const result = await Shell.run("echo one && echo two | tr a-z A-Z")
    expect(result.exitCode).toBe(0)
    expect(result.text().trim().split(/\r?\n/)).toEqual(["one", "TWO"])
  })

  test("runs in the given directory with the given environment", async () => {
    await using dir = await tmpdir()
    const result = await Shell.run('echo "$PROBE" && pwd', { cwd: dir.path, env: { PROBE: "probe-ok" } })
    const [probe] = result.text().trim().split(/\r?\n/)
    expect(probe).toBe("probe-ok")
  })

  test("returns the exit code and stderr on failure without throwing", async () => {
    const result = await Shell.run("echo bad >&2; exit 3")
    expect(result.exitCode).toBe(3)
    expect(result.stderr.toString().trim()).toBe("bad")
  })
})

describe("Shell.quote", () => {
  test("single-quotes by POSIX rules and escapes embedded single quotes", async () => {
    const value = `it's "quoted" $HOME \`x\``
    const result = await Shell.run(`printf '%s' ${Shell.quote(value)}`)
    expect(result.text()).toBe(value)
  })
})
