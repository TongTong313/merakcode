import http from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { afterAll, beforeAll, expect, test } from "vitest"
import { Filesystem } from "@merakcode/util/filesystem"
import { Ripgrep } from "@merakcode/engine/file/ripgrep"
import { tmpdir } from "../fixture/fixture"

// No rg on PATH or on disk, and a download that never answers, as when GitHub cannot be reached
const saved = { path: process.env.PATH, base: process.env.MERAKCODE_RIPGREP_BASE_URL }
const requested: string[] = []
const server = http.createServer((request) => void requested.push(request.url ?? ""))

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  process.env.PATH = ""
  process.env.MERAKCODE_RIPGREP_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.closeAllConnections()
  server.close()
  process.env.PATH = saved.path
  if (saved.base === undefined) delete process.env.MERAKCODE_RIPGREP_BASE_URL
  else process.env.MERAKCODE_RIPGREP_BASE_URL = saved.base
})

test("files are listed right away instead of waiting for rg to download", async () => {
  await using tmp = await tmpdir({ init: (dir) => Filesystem.write(path.join(dir, "project", "notes.txt"), "") })
  const started = Date.now()
  expect(await Array.fromAsync(Ripgrep.files({ cwd: path.join(tmp.path, "project") }))).toEqual(["notes.txt"])
  expect(Date.now() - started).toBeLessThan(3_000)
}, 30_000)

test("rg is still downloaded meanwhile, for content search and later listings that follow .gitignore", async () => {
  await using tmp = await tmpdir()
  await Array.fromAsync(Ripgrep.files({ cwd: tmp.path }))
  await expect.poll(() => requested.some((url) => url.includes("ripgrep-"))).toBe(true)
})
