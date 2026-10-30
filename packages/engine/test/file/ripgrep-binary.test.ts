import fs from "node:fs/promises"
import path from "node:path"
import { afterAll, beforeAll, expect, test } from "vitest"
import { Global } from "@merakcode/engine/infra/global/index"
import { Ripgrep } from "@merakcode/engine/infra/file/ripgrep"

// No rg on PATH and no download, so only a binary placed in Global.Path.bin counts
const saved = { path: process.env.PATH, download: process.env.MERAKCODE_RIPGREP_DISABLE_DOWNLOAD }
beforeAll(() => {
  process.env.PATH = ""
  process.env.MERAKCODE_RIPGREP_DISABLE_DOWNLOAD = "1"
})
afterAll(() => {
  process.env.PATH = saved.path
  if (saved.download === undefined) delete process.env.MERAKCODE_RIPGREP_DISABLE_DOWNLOAD
  else process.env.MERAKCODE_RIPGREP_DISABLE_DOWNLOAD = saved.download
})

test("a remembered rg that has since been deleted is looked up again instead of being spawned", async () => {
  const binary = path.join(Global.Path.bin, "rg" + (process.platform === "win32" ? ".exe" : ""))
  await fs.mkdir(Global.Path.bin, { recursive: true })
  await fs.writeFile(binary, "")
  expect(await Ripgrep.filepath()).toBe(binary)

  await fs.rm(binary)
  expect(await Ripgrep.filepath()).toBeUndefined()
})
