// IMPORTANT: Set env vars BEFORE any imports from src/ directory
// @merakcode/util/paths reads MERAKCODE_HOME at import time, so we must set these first
import os from "os"
import path from "path"
import fs from "fs/promises"
import fsSync from "fs"
import { fileURLToPath } from "url"
import { afterAll } from "vitest"

const dir = path.join(os.tmpdir(), "merakcode-test-data-" + process.pid)
// Remove before creating: the directory is named after the pid. If a test process exits before afterAll (crash or
// timeout kill), cleanup never runs and the directory stays in tmp. Windows reuses pids quickly, so a later process
// with the same pid would reuse the stale directory: at best it reads the old config/cache, at worst the symlink
// below throws EEXIST and the failed preload takes down every file in the shard.
// A live process cannot share our pid, so deleting the directory here is safe.
fsSync.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
await fs.mkdir(dir, { recursive: true })
afterAll(async () => {
  // Close file watchers before exiting, as the CLI does: exiting with live subscriptions crashes the watcher module
  // (Linux 134, Windows 0xC0000005). Then wait for tmpdir's background removals. These modules depend on engine
  // sources and must load after the env vars above are set, hence the dynamic imports.
  const { closeParcelWatchers } = await import("../src/file/parcel-binding")
  await closeParcelWatchers()
  const { removing } = await import("./fixture/fixture")
  await removing()
  // An open database keeps its files locked on Windows
  const { Database } = await import("../src/storage/db")
  Database.close()
  try {
    fsSync.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {}
  // On Windows, antivirus scans fresh files and removing temp dirs under heavy test concurrency can take tens of
  // seconds; slow cleanup is not a test failure
}, 120_000)
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
process.env["MERAKCODE_MODELS_PATH"] = path.join(import.meta.dirname, "tool", "fixtures", "models-api.json")
// Tests behave the same on every system; the sandbox modes have their own tests (test/sandbox)
process.env["MERAKCODE_SANDBOX_MODE"] = "off"

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

// Clear model keys from the dev machine so a developer key cannot leak into a test process.
for (const key of Object.keys(process.env))
  if (/_API_KEY$/.test(key) || /^AWS_(ACCESS_KEY_ID|PROFILE|REGION|BEARER_TOKEN_BEDROCK)$/.test(key))
    delete process.env[key]

// No remote config source is injected, so tests never contact one.

// Now safe to import from src/
const { Log } = await import("@merakcode/log/logger")

Log.init({
  print: false,
  dev: true,
  level: "DEBUG",
})
