// The product version must be set before any engine module is evaluated (see src/product-version.ts)
import "../src/product-version"

// IMPORTANT: Set env vars BEFORE any imports from src/ directory
// @merakcode/util/paths reads MERAKCODE_HOME at import time, so we must set these first
import os from "os"
import path from "path"
import fs from "fs/promises"
import fsSync from "fs"
import { fileURLToPath } from "url"
import { afterAll, afterEach, beforeEach } from "vitest"

const dir = path.join(os.tmpdir(), "merakcode-test-data-" + process.pid)
// Remove before creating: the directory is named after the pid. If a test process exits before afterAll (crash or
// timeout kill), cleanup never runs and the directory stays in tmp. Windows reuses pids quickly, and a later process
// with the same pid would reuse the stale directory: at best it reads the previous config/cache, at worst the symlink
// below throws EEXIST and the failed preload takes down all 20 files of the shard.
// A pid cannot collide with a live process, so removing the directory here is safe.
fsSync.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
await fs.mkdir(dir, { recursive: true })
afterAll(async () => {
  // Wait for tmpdir's background removals first. fixture depends on engine source and must load only after the
  // environment variables above are set, hence the dynamic import
  const { removing } = await import("./fixture/fixture")
  await removing()
  try {
    fsSync.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {}
})
// Set test home directory to isolate tests from user's actual home directory
// This prevents tests from picking up real user configs/skills from ~/.claude/skills
const testHome = path.join(dir, "home")
await fs.mkdir(testHome, { recursive: true })
process.env["MERAKCODE_TEST_HOME"] = testHome

// Set test managed config directory to isolate tests from system managed settings
const testManagedConfigDir = path.join(dir, "managed")
process.env["MERAKCODE_TEST_MANAGED_CONFIG_DIR"] = testManagedConfigDir

const root = path.join(dir, "root")
process.env["MERAKCODE_HOME"] = root

/** Warnings and errors from log files written since `since`, newest last, a few per file */
function problems(since: number) {
  const logs = path.join(root, "logs")
  const files = (() => {
    try {
      return fsSync.readdirSync(logs, { recursive: true, encoding: "utf8" })
    } catch {
      return []
    }
  })()
  const out: string[] = []
  for (const name of files.filter((file) => file.endsWith(".ndjson"))) {
    const file = path.join(logs, name)
    if (fsSync.statSync(file).mtimeMs < since) continue
    const lines = fsSync
      .readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line) => {
        try {
          const record = JSON.parse(line) as { level?: string; timestamp?: string; service?: string; message?: string }
          return record.level === "WARN" || record.level === "ERROR" || record.level === "FATAL" ? [line] : []
        } catch {
          return []
        }
      })
    if (lines.length) out.push(`--- ${name}`, ...lines.slice(-40))
  }
  return out.join("\n")
}

// A failed test prints what the engines it started logged as warnings and errors. The log directory is removed with
// this test process, so on CI nothing else would be left to explain a crashed or refusing engine.
let started = 0
beforeEach(() => {
  started = Date.now()
})
afterEach((context) => {
  if (context.task.result?.state !== "fail") return
  const found = problems(started)
  if (found) process.stderr.write(`\nEngine warnings and errors during "${context.task.name}":\n${found}\n`)
})
// Engines started by the tests behave the same on every system (the sandbox has its own tests)
process.env["MERAKCODE_SANDBOX_MODE"] = "off"
// Share the model catalog fixture with the engine tests
process.env["MERAKCODE_MODELS_PATH"] = path.join(
  import.meta.dirname,
  "../../../packages/engine/test/tool/fixtures/models-api.json",
)

// Reuse the workspace's installed zod package in the isolated global config.
// Config still writes and validates its plugin shim without repeating `npm install zod` in every test process.
const modules = path.join(root, "node_modules")
await fs.mkdir(modules, { recursive: true })
await fs.symlink(
  path.dirname(fileURLToPath(import.meta.resolve("zod"))),
  path.join(modules, "zod"),
  process.platform === "win32" ? "junction" : "dir",
)

// Write the cache version file to prevent global/index.ts from clearing the cache
const cacheDir = path.join(root, "cache")
await fs.mkdir(cacheDir, { recursive: true })
await fs.writeFile(path.join(cacheDir, "version"), "21")

// Clear provider env vars to ensure clean test state
delete process.env["ANTHROPIC_API_KEY"]
delete process.env["OPENAI_API_KEY"]
delete process.env["GOOGLE_API_KEY"]
delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"]
delete process.env["AZURE_OPENAI_API_KEY"]
delete process.env["AWS_ACCESS_KEY_ID"]
delete process.env["AWS_PROFILE"]
delete process.env["AWS_REGION"]
delete process.env["AWS_BEARER_TOKEN_BEDROCK"]
delete process.env["OPENROUTER_API_KEY"]
delete process.env["GROQ_API_KEY"]
delete process.env["MISTRAL_API_KEY"]
delete process.env["PERPLEXITY_API_KEY"]
delete process.env["TOGETHER_API_KEY"]
delete process.env["XAI_API_KEY"]
delete process.env["DEEPSEEK_API_KEY"]
delete process.env["FIREWORKS_API_KEY"]
delete process.env["CEREBRAS_API_KEY"]
delete process.env["SAMBANOVA_API_KEY"]

// Now safe to import from src/
const { Log } = await import("@merakcode/log/logger")

Log.init({
  print: false,
  dev: true,
  level: "DEBUG",
})
