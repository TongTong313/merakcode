/**
 * merak provider list: lists providers with stored credentials (without the keys) and keys detected in the environment
 */
import { expect, test } from "vitest"
import path from "path"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"
import { cli, tmpdir } from "../fixture/fixture"

async function merak(cwd: string, env: Record<string, string>, ...args: string[]) {
  const proc = Process.spawn([...cli, ...args], {
    cwd,
    env: { ...process.env, MERAKCODE_LOCALE: "en", MERAKCODE_DISABLE_MODELS_FETCH: "1", ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { output: stdout + stderr, code }
}

test(
  "list shows stored credentials with their type but no key, and environment keys separately",
  { timeout: 60_000 },
  async () => {
    await using tmp = await tmpdir()
    const file = path.join(process.env.XDG_DATA_HOME!, "merakcode", "auth.json")
    await Filesystem.write(file, JSON.stringify({ deepseek: { type: "api", key: "sk-stored-secret" } }))
    try {
      const result = await merak(tmp.path, { ANTHROPIC_API_KEY: "sk-env-secret" }, "provider", "list")
      expect(result.code, result.output).toBe(0)
      expect(result.output).toMatch(/DeepSeek .*api/)
      expect(result.output).toContain("1 credential(s)")
      expect(result.output).toMatch(/Anthropic .*ANTHROPIC_API_KEY/)
      expect(result.output).not.toContain("sk-stored-secret")
      expect(result.output).not.toContain("sk-env-secret")
    } finally {
      await Filesystem.write(file, "{}")
    }
  },
)
