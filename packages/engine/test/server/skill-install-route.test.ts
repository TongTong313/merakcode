import { afterEach, describe, expect, test } from "vitest"
import path from "path"
import { Server } from "@merakcode/engine/app/server/server"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"

// Intercept only git clone (the server may spawn other processes): write a SKILL.md into the target and succeed
function mockCloneCapture(capture: (cmd: string[], opts: Record<string, any>) => void) {
  Process.spawn = ((cmd: string[], opts: Record<string, any>) => {
    const isClone = Array.isArray(cmd) && cmd.includes("clone")
    if (isClone) capture(cmd, opts)
    const setup = (async () => {
      if (isClone) {
        const dest = cmd.at(-1)!
        const { mkdir } = await import("fs/promises")
        const d = path.join(dest, "foo")
        await mkdir(d, { recursive: true })
        await Filesystem.write(path.join(d, "SKILL.md"), `---\nname: foo\n---\n`)
      }
      return 0
    })()
    return { exited: setup, stderr: new ReadableStream() } as Process.Child
  }) as typeof Process.spawn
}

describe("skill-install list route (optional token for cloning)", () => {
  const originalSpawn = Process.spawn
  afterEach(() => {
    Process.spawn = originalSpawn
    delete process.env.MERAKCODE_TEST_SKILL_CACHE
  })

  test("a token in the body is passed to clone through GIT_CONFIG http.extraHeader, not argv", async () => {
    await using tmp = await tmpdir()
    process.env.MERAKCODE_TEST_SKILL_CACHE = tmp.path
    let argv: string[] | undefined
    let env: Record<string, any> | undefined
    mockCloneCapture((cmd, opts) => {
      argv = cmd
      env = opts?.env
    })

    const res = await Server.App().request("http://localhost/skill-install/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "https://gitee.com/o/r.git", token: "PAT-XYZ" }),
    })

    expect(res.status).toBe(200)
    expect(argv?.join(" ")).not.toContain("PAT-XYZ")
    expect(env?.GIT_CONFIG_KEY_0).toBe("http.extraHeader")
    expect(env?.GIT_CONFIG_VALUE_0).toContain(`Basic ${btoa("oauth2:PAT-XYZ")}`)
  })

  test("without a token the clone stays non-interactive and sets no extraHeader", async () => {
    await using tmp = await tmpdir()
    process.env.MERAKCODE_TEST_SKILL_CACHE = tmp.path
    let env: Record<string, any> | undefined
    mockCloneCapture((_cmd, opts) => {
      env = opts?.env
    })

    const res = await Server.App().request("http://localhost/skill-install/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "https://gitee.com/o/r.git" }),
    })

    expect(res.status).toBe(200)
    expect(env?.GIT_CONFIG_KEY_0).toBeUndefined()
  })
})
