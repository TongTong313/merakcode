import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { expect, test } from "vitest"

const src = path.join(import.meta.dirname, "..", "src")

test("every engine source file loads on plain Node, without a TypeScript loader", () => {
  const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter(
    (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
  )
  const script = files
    .map((file) => `await import(${JSON.stringify(pathToFileURL(path.join(src, file)).href)})`)
    .join("\n")
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    env: { ...process.env, NODE_OPTIONS: undefined },
    encoding: "utf8",
  })
  expect(result.stderr).toBe("")
  expect(result.status).toBe(0)
})
