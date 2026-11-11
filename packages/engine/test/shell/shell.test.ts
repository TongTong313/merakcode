import { describe, expect, test } from "vitest"
import { Shell } from "../../src/infra/process/shell/shell"
import { runtime, tmpdir } from "../fixture/fixture"
import { Process } from "@merakcode/util/process"
import path from "node:path"
import { pathToFileURL } from "node:url"

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

test.runIf(process.platform === "win32")(
  "terminal selection preserves explicit shells and finds Windows PowerShell without pwsh",
  async () => {
    const module = pathToFileURL(path.resolve(import.meta.dirname, "../../src/infra/process/shell/shell.ts")).href
    const powershell = path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0")
    for (const [selection, env] of [
      ["cmd.exe", { SHELL: "cmd.exe" }],
      ["selected-bash.exe", { MERAKCODE_GIT_BASH_PATH: "selected-bash.exe" }],
      [path.join(powershell, "powershell.exe"), { PATH: powershell }],
    ] as const) {
      const result = await Process.run(
        [
          ...runtime,
          "--input-type=module",
          "--eval",
          `const {Shell}=await import(${JSON.stringify(module)});process.stdout.write(Shell.terminal())`,
        ],
        { env: { ...process.env, SHELL: "", MERAKCODE_GIT_BASH_PATH: "", ...env } },
      )
      expect(result.exitCode).toBe(0)
      expect(result.text().toLowerCase()).toBe(selection.toLowerCase())
    }
  },
)
