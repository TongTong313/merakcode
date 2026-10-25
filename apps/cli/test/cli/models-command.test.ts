/**
 * merak models --refresh fetches the connected provider's own model list.
 * A local server speaks the DeepSeek list shape; the provider's base URL points at it.
 */
import { expect, test } from "vitest"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { Process } from "@merakcode/util/process"
import { cli, tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"
import path from "path"

async function source() {
  const state = { models: ["fake-coder-1"] }
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ data: state.models.map((id) => ({ id, name: id })) }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    state,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    [Symbol.asyncDispose]: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function merak(home: string, cwd: string, ...args: string[]) {
  const proc = Process.spawn([...cli, ...args], {
    cwd,
    env: {
      ...process.env,
      MERAKCODE_LOCALE: "en",
      MERAKCODE_HOME: home,
      MERAKCODE_DISABLE_CATALOG_FETCH: "1",
    },
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

test("--refresh lists new models after fetching them from the provider", { timeout: 90_000 }, async () => {
  await using models = await source()
  await using tmp = await tmpdir()
  await Filesystem.write(
    path.join(tmp.path, "merakcode.json"),
    JSON.stringify({ provider: { deepseek: { options: { apiKey: "sk-test", baseURL: models.url } } } }),
  )

  const first = await merak(tmp.path, tmp.path, "models", "deepseek", "--refresh")
  expect(first.code, first.stderr + first.stdout).toBe(0)
  expect(first.stdout + first.stderr).toContain("Models cache refreshed")
  expect(first.stdout.split(/\r?\n/).filter((line) => line.startsWith("deepseek/"))).toEqual(["deepseek/fake-coder-1"])

  models.state.models = ["fake-coder-1", "fake-coder-2"]
  const second = await merak(tmp.path, tmp.path, "models", "deepseek", "--refresh")
  expect(second.stdout.split(/\r?\n/).filter((line) => line.startsWith("deepseek/"))).toEqual([
    "deepseek/fake-coder-1",
    "deepseek/fake-coder-2",
  ])
})

test("a provider that is not connected is reported as not found", { timeout: 90_000 }, async () => {
  await using tmp = await tmpdir()
  const result = await merak(tmp.path, tmp.path, "models", "no-such-provider")
  expect(result.stderr + result.stdout).toContain("no-such-provider")
})
