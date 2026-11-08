import { expect, test } from "vitest"
import { createRequire } from "node:module"
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
  await bundle()
  const require = createRequire(path.resolve(import.meta.dirname, "../dist/main.js"))
  const Database = require("./node_modules/better-sqlite3")
  const db = new Database(":memory:")
  try {
    expect(db.prepare("SELECT 42 AS answer").get()).toEqual({ answer: 42 })
  } finally {
    db.close()
  }
}, 30000)
