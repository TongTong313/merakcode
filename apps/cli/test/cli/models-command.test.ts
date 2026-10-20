/**
 * merak models: lists the models of connected providers; --refresh first fetches the latest catalog from its source.
 * The catalog source is a local fake server (MERAKCODE_MODELS_URL); the provider connects through a key in the
 * environment
 */
import { expect, test } from "vitest"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { Process } from "@merakcode/util/process"
import { cli, tmpdir } from "../fixture/fixture"

function catalog(models: string[]) {
  return {
    "fake-cloud": {
      id: "fake-cloud",
      name: "Fake Cloud",
      env: ["FAKE_CLOUD_API_KEY"],
      npm: "@ai-sdk/openai-compatible",
      api: "http://127.0.0.1:9/v1",
      models: Object.fromEntries(
        models.map((id) => [
          id,
          {
            id,
            name: id,
            release_date: "2026-01-01",
            attachment: false,
            reasoning: false,
            temperature: true,
            tool_call: true,
            limit: { context: 128000, output: 8192 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        ]),
      ),
    },
  }
}

async function source() {
  const state = { models: ["fake-coder-1"], requests: 0 }
  const server = http.createServer((req, res) => {
    state.requests++
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify(catalog(state.models)))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    state,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    [Symbol.asyncDispose]: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function merak(cwd: string, url: string, ...args: string[]) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    MERAKCODE_LOCALE: "en",
    MERAKCODE_MODELS_URL: url,
    FAKE_CLOUD_API_KEY: "sk-test",
  }
  // Skip the fixture's fixed catalog so the command goes through the cache to the catalog source
  delete env.MERAKCODE_MODELS_PATH
  delete env.MERAKCODE_DISABLE_MODELS_FETCH
  const proc = Process.spawn([...cli, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
}

test("--refresh lists new models after fetching them from the catalog", { timeout: 90_000 }, async () => {
  await using tmp = await tmpdir()
  await using models = await source()

  const first = await merak(tmp.path, models.url, "models", "fake-cloud", "--refresh")
  expect(first.code, first.stderr).toBe(0)
  expect(first.stderr).toContain("Models cache refreshed")
  expect(first.stdout.split(/\r?\n/).filter((line) => line.startsWith("fake-cloud/"))).toEqual([
    "fake-cloud/fake-coder-1",
  ])

  models.state.models = ["fake-coder-1", "fake-coder-2"]
  const second = await merak(tmp.path, models.url, "models", "fake-cloud", "--refresh")
  expect(second.stdout.split(/\r?\n/).filter((line) => line.startsWith("fake-cloud/"))).toEqual([
    "fake-cloud/fake-coder-1",
    "fake-cloud/fake-coder-2",
  ])
})

test("a provider that is not connected is reported as not found", { timeout: 90_000 }, async () => {
  await using tmp = await tmpdir()
  await using models = await source()
  const result = await merak(tmp.path, models.url, "models", "no-such-provider")
  expect(result.stderr).toContain("no-such-provider")
})
