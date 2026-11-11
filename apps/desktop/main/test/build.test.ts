import { expect, test } from "vitest"
import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { bundle } from "../script/build"
import { build } from "esbuild"

test("bundles the public SDK for a browser ", async () => {
  const result = await build({
    stdin: { contents: 'export { connect, foldSession } from "@merakcode/sdk"', resolveDir: import.meta.dirname },
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
  })
  expect(result.outputFiles[0]?.text).toContain("connect")
  expect(Object.keys(result.metafile.inputs).some((file) => file.includes("better-sqlite3"))).toBe(false)
})

test("bundles the main process and the preload", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "merak-desktop-build-"))
  try {
    await bundle({ outdir: output })
    await access(path.join(output, "main.js"))
    await access(path.join(output, "preload.cjs"))
    await expect(access(path.join(output, "node_modules"))).rejects.toThrow()
  } finally {
    await rm(output, { recursive: true, force: true })
  }
}, 30000)
