/**
 * merak mcp: list shows the configured MCP servers and their status; auth explains why a server cannot be authorized
 */
import { expect, test } from "vitest"
import { Process } from "@merakcode/util/process"
import { cli, tmpdir } from "../fixture/fixture"

async function merak(cwd: string, ...args: string[]) {
  const proc = Process.spawn([...cli, ...args], {
    cwd,
    env: { ...process.env, MERAKCODE_LOCALE: "en", MERAKCODE_DISABLE_MODELS_FETCH: "1" },
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

test("list shows each configured server with its status and how it starts", { timeout: 90_000 }, async () => {
  await using tmp = await tmpdir({
    config: {
      mcp: {
        files: { type: "local", command: ["node", "server.js"], enabled: false },
        docs: { type: "remote", url: "https://example.invalid/mcp", enabled: false },
      },
    },
  })
  const result = await merak(tmp.path, "mcp", "list")
  expect(result.code).toBe(0)
  expect(result.output).toMatch(/○ files .*disabled[\s\S]*node server\.js/)
  expect(result.output).toMatch(/○ docs .*disabled[\s\S]*https:\/\/example\.invalid\/mcp/)
  expect(result.output).toContain("2 server(s)")
})

test("list explains how to add a server when none is configured", { timeout: 90_000 }, async () => {
  await using tmp = await tmpdir()
  const result = await merak(tmp.path, "mcp", "list")
  expect(result.output).toContain("No MCP servers configured")
})

test("auth fails with a reason for an unknown server or one without OAuth support", { timeout: 90_000 }, async () => {
  await using tmp = await tmpdir({
    config: { mcp: { files: { type: "local", command: ["node", "server.js"], enabled: false } } },
  })
  const missing = await merak(tmp.path, "mcp", "auth", "nope")
  expect(missing.code).toBe(1)
  expect(missing.output).toContain("No MCP server named nope in your config")

  const local = await merak(tmp.path, "mcp", "auth", "files")
  expect(local.code).toBe(1)
  expect(local.output).toContain("files can't be authorized with OAuth")
})
