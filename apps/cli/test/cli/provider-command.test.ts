/**
 * merak provider list: lists providers with stored credentials, without the keys
 */
import { expect, test } from "vitest"
import path from "path"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"
import { cli, tmpdir } from "../fixture/fixture"

async function merak(cwd: string, env: Record<string, string>, ...args: string[]) {
  const proc = Process.spawn([...cli, ...args], {
    cwd,
    env: { ...process.env, MERAKCODE_LOCALE: "en", MERAKCODE_DISABLE_CATALOG_FETCH: "1", ...env },
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

test("list shows stored credentials with their type but no key", { timeout: 60_000 }, async () => {
  await using tmp = await tmpdir()
  const file = path.join(process.env.MERAKCODE_HOME!, "data", "auth.json")
  await Filesystem.write(file, JSON.stringify({ deepseek: { type: "api", key: "sk-stored-secret" } }))
  try {
    const result = await merak(tmp.path, {}, "provider", "list")
    expect(result.code, result.output).toBe(0)
    expect(result.output).toMatch(/DeepSeek .*api/)
    expect(result.output).toContain("1 credential(s)")
    expect(result.output).not.toContain("sk-stored-secret")
    expect(result.output).not.toContain("ANTHROPIC_API_KEY")
  } finally {
    await Filesystem.write(file, "{}")
  }
})

test(
  "relay saves the context length the station returned and keeps the key out of config",
  { timeout: 60_000 },
  async () => {
    const { createServer } = await import("node:http")
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json")
      response.end(
        JSON.stringify({ data: [{ id: "claude-sonnet-4-5", context_length: 180_000, max_output_tokens: 8_000 }] }),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    const port = (server.address() as { port: number }).port
    await using tmp = await tmpdir()
    try {
      const result = await merak(
        tmp.path,
        {},
        "provider",
        "relay",
        "--name",
        "Packy",
        "--url",
        `http://127.0.0.1:${port}`,
        "--key",
        "sk-relay-secret",
        "--kind",
        "claude-code",
      )
      expect(result.code, result.output).toBe(0)
      const configDir = process.env.MERAKCODE_HOME!
      const configFile = (await Filesystem.exists(path.join(configDir, "merakcode.jsonc")))
        ? path.join(configDir, "merakcode.jsonc")
        : path.join(configDir, "merakcode.json")
      const config = (await Filesystem.readJson(configFile)) as {
        provider: Record<
          string,
          { relay?: { kind?: string }; models?: Record<string, { limit?: { context?: number } }> }
        >
      }
      const provider = config.provider["packy-claude-code"]
      expect(provider?.relay?.kind).toBe("claude-code")
      expect(provider?.models?.["claude-sonnet-4-5"]?.limit?.context).toBe(180_000)
      expect(JSON.stringify(provider)).not.toContain("sk-relay-secret")
      const auth = (await Filesystem.readJson(path.join(process.env.MERAKCODE_HOME!, "data", "auth.json"))) as Record<
        string,
        { key?: string }
      >
      expect(auth["packy-claude-code"]?.key).toBe("sk-relay-secret")
    } finally {
      await new Promise((resolve) => server.close(resolve))
      await Filesystem.write(path.join(process.env.MERAKCODE_HOME!, "data", "auth.json"), "{}").catch(() => {})
    }
  },
)

test("relay saves an undescribed model without made-up windows or capabilities", { timeout: 60_000 }, async () => {
  const { createServer } = await import("node:http")
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ data: [{ id: "local-model" }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const port = (server.address() as { port: number }).port
  await using tmp = await tmpdir()
  try {
    const result = await merak(
      tmp.path,
      {},
      ...["provider", "relay", "--name", "Local", "--url", `http://127.0.0.1:${port}`, "--key", "sk-local"],
      ...["--kind", "standard"],
    )
    expect(result.code, result.output).toBe(0)
    const configDir = process.env.MERAKCODE_HOME!
    const configFile = (await Filesystem.exists(path.join(configDir, "merakcode.jsonc")))
      ? path.join(configDir, "merakcode.jsonc")
      : path.join(configDir, "merakcode.json")
    const config = (await Filesystem.readJson(configFile)) as {
      provider: Record<string, { models?: Record<string, Record<string, unknown>> }>
    }
    const model = config.provider["local-standard"]?.models?.["local-model"]
    expect(model).toEqual({ name: "local-model", provider: { npm: "@ai-sdk/openai-compatible" } })
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await Filesystem.write(path.join(process.env.MERAKCODE_HOME!, "data", "auth.json"), "{}").catch(() => {})
  }
})
