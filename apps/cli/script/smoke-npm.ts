/** Exercise the published packages from an isolated consumer, including their default engine discovery. */
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { checkCli } from "./smoke-npm-command"

const execute = promisify(execFile)
const require = createRequire(new URL("../../../packages/sdk/js/package.json", import.meta.url))
const nodeTypes = (
  JSON.parse(await readFile(require.resolve("@types/node/package.json"), "utf8")) as { version: string }
).version
const packages = path.resolve(process.argv[2] ?? "apps/cli/dist/npm")
const version = (JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string })
  .version
const platform = `merakcode-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
const files = await readdir(packages)
const archives = [`${platform}-${version}.tgz`, `merakcode-sdk-${version}.tgz`, `merakcode-${version}.tgz`]
for (const file of archives) if (!files.includes(file)) throw new Error(`Missing npm artifact: ${file}`)
const node = path.dirname(process.execPath)
const npm = [
  path.join(node, "node_modules/npm/bin/npm-cli.js"),
  path.join(node, "../lib/node_modules/npm/bin/npm-cli.js"),
].find(existsSync)
if (!npm) throw new Error("npm bundled with node not found")
const root = await mkdtemp(path.join(os.tmpdir(), "merakcode-npm-consumer-"))
try {
  await writeFile(path.join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
  await execute(
    process.execPath,
    [
      npm,
      "install",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      "--omit=optional",
      `@types/node@${nodeTypes}`,
      ...archives.map((file) => path.join(packages, file)),
    ],
    { cwd: root, timeout: 180_000, windowsHide: true },
  )
  await checkCli(root, version)
  const runtime = `
import assert from "node:assert/strict"
import { createMerakCodeClient } from "@merakcode/sdk/client"
import { startEngine } from "@merakcode/sdk/process"
await Promise.all([
  import("@merakcode/sdk"), import("@merakcode/sdk/errors"), import("@merakcode/sdk/store"),
  import("@merakcode/sdk/plugin"), import("@merakcode/sdk/adapter"), import("@merakcode/sdk/transcript"),
])
const engine = await startEngine({ cwd: process.cwd(), timeout: 60000, config: { lsp: false } })
try {
  const client = createMerakCodeClient({ baseUrl: engine.url, headers: engine.headers, throwOnError: true })
  const health = await client.global.health()
  assert.equal(health.data.healthy, true)
  assert.equal(health.data.version, ${JSON.stringify(version)})
} finally { await engine.close() }
assert.equal(await engine.exited, 0)
`
  await writeFile(path.join(root, "consumer.mjs"), runtime)
  await writeFile(
    path.join(root, "consumer.ts"),
    `
import { createMerakCodeClient, type Session } from "@merakcode/sdk"
import { startEngine, type Engine } from "@merakcode/sdk/process"
import * as errors from "@merakcode/sdk/errors"
import * as store from "@merakcode/sdk/store"
import * as plugin from "@merakcode/sdk/plugin"
import * as adapter from "@merakcode/sdk/adapter"
import * as transcript from "@merakcode/sdk/transcript"
export const consumer = { createMerakCodeClient, startEngine, errors, store, plugin, adapter, transcript }
export type Types = { session: Session; engine: Engine }
`,
  )
  const tsc = path.join(path.dirname(require.resolve("typescript/package.json")), "bin/tsc")
  await execute(
    process.execPath,
    [
      tsc,
      "--noEmit",
      "--strict",
      "--module",
      "NodeNext",
      "--target",
      "ES2022",
      "--types",
      "node",
      "--skipLibCheck",
      "false",
      "consumer.ts",
    ],
    { cwd: root, timeout: 60_000, windowsHide: true },
  )
  for (const executable of new Set(
    [process.execPath, process.env.MERAKCODE_SMOKE_SDK_NODE].filter((value): value is string => !!value),
  )) {
    await execute(executable, ["consumer.mjs"], {
      cwd: root,
      timeout: 90_000,
      windowsHide: true,
      env: {
        ...process.env,
        MERAKCODE_HOME: path.join(root, "data"),
        MERAKCODE_TEST_HOME: path.join(root, "home"),
        MERAKCODE_SANDBOX_MODE: "off",
        MERAKCODE_DISABLE_CATALOG_FETCH: "1",
        MERAKCODE_DISABLE_LSP_DOWNLOAD: "1",
        MERAKCODE_DISABLE_EXTERNAL_SKILLS: "1",
      },
    })
  }
  process.stdout.write(`npm consumer passed: ${platform}, Node ${process.versions.node}\n`)
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
}
