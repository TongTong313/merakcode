import { expect, test } from "vitest"
import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import { bundle } from "../script/build"
import { build } from "esbuild"

test("bundles the public SDK for a browser without native storage", async () => {
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

test("bundles a main process with a loadable native storage host", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "merak-desktop-build-"))
  try {
    await bundle({ outdir: output })
    await access(path.join(output, "main.js"))
    await access(path.join(output, "preload.cjs"))
    // A separate process releases the native module before Windows removes the temporary output.
    const result = await promisify(execFile)(
      process.execPath,
      [
        "-e",
        `
      const Database = require(process.argv[1])
      const db = new Database(':memory:')
      process.stdout.write(JSON.stringify(db.prepare('SELECT 42 AS answer').get()))
      db.close()
    `,
        path.join(output, "node_modules/better-sqlite3"),
      ],
      { windowsHide: true },
    )
    expect(JSON.parse(result.stdout)).toEqual({ answer: 42 })
  } finally {
    await rm(output, { recursive: true, force: true })
  }
}, 30000)
